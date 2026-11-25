import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	dialog360ApiRequest,
	epochToIso,
	flattenStatus,
	isValidSignature,
	SIGNATURE_HEADER,
} from './GenericFunctions';

const MEDIA_TYPES = ['image', 'video', 'document', 'audio', 'sticker'] as const;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 500;

const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

export class Dialog360Trigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: '360dialog Trigger',
		name: 'dialog360Trigger',
		icon: { light: 'file:dialog360.svg', dark: 'file:dialog360.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when a WhatsApp message arrives or a sent message changes status via 360dialog',
		defaults: {
			name: '360dialog Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dialog360Api',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{
						name: 'Message Received',
						value: 'messageReceived',
						description: 'A WhatsApp user sent a message to your number',
					},
					{
						name: 'Status Update',
						value: 'statusUpdate',
						description:
							'A message you sent was sent, delivered, read or failed. Each item has an "event" field set to "status".',
					},
				],
				default: ['messageReceived'],
			},
			{
				displayName: 'Status Types',
				name: 'statusTypes',
				type: 'multiOptions',
				options: [
					{ name: 'Delivered', value: 'delivered' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Read', value: 'read' },
					{ name: 'Sent', value: 'sent' },
				],
				default: ['sent', 'delivered', 'read', 'failed'],
				description: 'Which status updates start the workflow',
				displayOptions: {
					show: {
						events: ['statusUpdate'],
					},
				},
			},
			{
				displayName:
					'Add the Webhook Secret to the 360dialog credential to reject requests that were not signed by 360dialog (x-360dialog-signature).',
				name: 'signatureNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName:
					'Users can hide their phone number behind a WhatsApp username. Key conversations on the always-present “fromUserId” (Business-Scoped User ID); treat “from” and “waId” as optional. A “system” event with “newUserId” means the user changed phone numbers and stored user IDs must be remapped.',
				name: 'bsuidNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName:
					'360dialog delivers events to a single webhook URL per number. Activating this workflow points that webhook at n8n; the previous URL is restored when the workflow is deactivated.',
				name: 'webhookNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const config = await dialog360ApiRequest.call(this, 'GET', '/v1/configs/webhook');
				return config.url === webhookUrl;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const staticData = this.getWorkflowStaticData('node');

				// Remember the currently configured webhook so deactivation can
				// restore it. 360dialog has ONE webhook per number.
				const current = await dialog360ApiRequest.call(this, 'GET', '/v1/configs/webhook');
				if (current.url && current.url !== webhookUrl) {
					staticData.previousWebhookUrl = current.url;
				}

				await dialog360ApiRequest.call(this, 'POST', '/v1/configs/webhook', {
					url: webhookUrl,
				});
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const previousUrl = staticData.previousWebhookUrl as string | undefined;

				if (previousUrl) {
					try {
						await dialog360ApiRequest.call(this, 'POST', '/v1/configs/webhook', {
							url: previousUrl,
						});
					} catch (error) {
						// Never block workflow deactivation on a restore failure
						this.logger.warn(`Could not restore the previous webhook URL: ${(error as Error).message}`);
					}
					delete staticData.previousWebhookUrl;
				}
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		// Signature first: nothing from an unsigned request reaches the workflow.
		const credentials = await this.getCredentials('dialog360Api');
		const secret = String(credentials.webhookSecret ?? '');
		if (secret) {
			const req = this.getRequestObject();
			const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
			if (!rawBody || !isValidSignature(rawBody, req.headers[SIGNATURE_HEADER], secret)) {
				const res = this.getResponseObject();
				res.status(401).send('Invalid signature').end();
				return { noWebhookResponse: true };
			}
		}

		const events = this.getNodeParameter('events', ['messageReceived']) as string[];
		const wantMessages = events.includes('messageReceived');
		const wantStatuses = events.includes('statusUpdate');
		const statusTypes = this.getNodeParameter('statusTypes', [
			'sent',
			'delivered',
			'read',
			'failed',
		]) as string[];

		const payload = this.getBodyData() as IDataObject;
		const staticData = this.getWorkflowStaticData('node');

		// Dedupe state: webhook delivery is at-least-once, so the same wamid
		// can arrive more than once.
		const now = Date.now();
		let seen = (staticData.seenMessageIds as Record<string, number> | undefined) ?? {};
		seen = Object.fromEntries(
			Object.entries(seen)
				.filter(([, ts]) => now - ts < DEDUPE_TTL_MS)
				.slice(-DEDUPE_MAX_ENTRIES),
		);

		const out: IDataObject[] = [];

		for (const entry of (payload.entry as IDataObject[] | undefined) ?? []) {
			for (const change of (entry.changes as IDataObject[] | undefined) ?? []) {
				const value = (change.value as IDataObject | undefined) ?? {};
				const metadata = (value.metadata as IDataObject | undefined) ?? {};

				if (wantStatuses) {
					for (const status of (value.statuses as IDataObject[] | undefined) ?? []) {
						if (statusTypes.includes(String(status.status))) {
							out.push(flattenStatus(status, metadata));
						}
					}
				}

				const messages = value.messages as IDataObject[] | undefined;
				if (!wantMessages || !Array.isArray(messages)) {
					continue;
				}
				const businessNumber = digits(metadata.display_phone_number);
				const contacts = value.contacts as IDataObject[] | undefined;
				const contact = contacts?.[0] ?? {};
				const profile = (contact.profile as IDataObject | undefined) ?? {};

				for (const msg of messages) {
					// Outbound echo: sent by the business number itself. Without this
					// filter, a workflow that replies re-triggers itself forever.
					if (businessNumber && digits(msg.from) === businessNumber) {
						continue;
					}
					if (msg.from_me === true) {
						continue;
					}
					// Redelivery of an already-processed message.
					const messageId = String(msg.id ?? '');
					if (messageId && seen[messageId]) {
						continue;
					}
					if (messageId) {
						seen[messageId] = now;
					}

					const flat: IDataObject = {
						event: 'message',
						messageId,
						// Only present when the sender's phone is visible to this
						// business. Users can hide their phone behind a username —
						// key conversations on fromUserId, not on from/waId.
						from: msg.from,
						waId: contact.wa_id,
						// Business-Scoped User ID: always present, stable per
						// business portfolio (regenerated only on phone change).
						fromUserId: msg.from_user_id,
						userId: contact.user_id,
						parentUserId: contact.parent_user_id,
						username: profile.username,
						contactName: profile.name,
						timestamp: epochToIso(msg.timestamp),
						type: msg.type,
					};
					// Phone change: all BSUIDs for this user were regenerated. The
					// old one returns error 131009 forever — remap stored ids.
					const system = msg.system as IDataObject | undefined;
					if (system) {
						flat.systemBody = system.body;
						flat.oldUserId = system.user_id;
						flat.newUserId = system.new_user_id;
					}
					const text = msg.text as IDataObject | undefined;
					if (text) {
						flat.text = text.body;
					}
					for (const mediaType of MEDIA_TYPES) {
						const media = msg[mediaType] as IDataObject | undefined;
						if (media) {
							flat[`${mediaType}Id`] = media.id;
							flat.mediaMimeType = media.mime_type;
							if (media.caption) {
								flat.caption = media.caption;
							}
						}
					}
					const location = msg.location as IDataObject | undefined;
					if (location) {
						flat.latitude = location.latitude;
						flat.longitude = location.longitude;
					}
					const button = msg.button as IDataObject | undefined;
					if (button) {
						flat.buttonText = button.text;
						flat.buttonPayload = button.payload;
					}
					const interactive = msg.interactive as IDataObject | undefined;
					if (interactive) {
						const reply = (interactive.button_reply ??
							interactive.list_reply ??
							{}) as IDataObject;
						flat.interactiveReplyId = reply.id;
						flat.interactiveReplyTitle = reply.title;
					}
					out.push(flat);
				}
			}
		}

		staticData.seenMessageIds = seen;

		if (!out.length) {
			// Acknowledge with 200 but do not start the workflow (unselected
			// events, echoes and duplicates end up here).
			return {};
		}

		return {
			workflowData: [this.helpers.returnJsonArray(out)],
		};
	}
}
