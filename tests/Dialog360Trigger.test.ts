import type { IDataObject, IWebhookFunctions } from 'n8n-workflow';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { Dialog360Trigger } from '../nodes/Dialog360/Dialog360Trigger.node';

interface ContextOptions {
	params?: IDataObject;
	secret?: string;
	rawBody?: Buffer;
	headers?: Record<string, string>;
	response?: { statusCode?: number; body?: string };
}

const makeContext = (body: IDataObject, staticData: IDataObject = {}, opts: ContextOptions = {}) =>
	({
		getBodyData: () => body,
		getWorkflowStaticData: () => staticData,
		getCredentials: async () => ({ apiKey: 'key', webhookSecret: opts.secret ?? '' }),
		getNodeParameter: (name: string, fallback: unknown) => opts.params?.[name] ?? fallback,
		getRequestObject: () => ({
			rawBody: opts.rawBody ?? Buffer.from(JSON.stringify(body)),
			headers: opts.headers ?? {},
		}),
		getResponseObject: () => {
			const res = {
				status: (code: number) => {
					if (opts.response) opts.response.statusCode = code;
					return res;
				},
				send: (text: string) => {
					if (opts.response) opts.response.body = text;
					return res;
				},
				end: () => res,
			};
			return res;
		},
		helpers: {
			returnJsonArray: (items: IDataObject[]) => items.map((json) => ({ json })),
		},
	}) as unknown as IWebhookFunctions;

const envelope = (value: IDataObject): IDataObject => ({
	object: 'whatsapp_business_account',
	entry: [
		{
			id: 'WABA',
			changes: [
				{
					value: {
						messaging_product: 'whatsapp',
						metadata: { display_phone_number: '4915199999999', phone_number_id: 'PNID' },
						...value,
					},
					field: 'messages',
				},
			],
		},
	],
});

const trigger = new Dialog360Trigger();

const emitted = async (body: IDataObject, staticData: IDataObject = {}, opts: ContextOptions = {}) => {
	const result = await trigger.webhook.call(makeContext(body, staticData, opts));
	return (result.workflowData?.[0] ?? []).map((item) => item.json as IDataObject);
};

describe('Dialog360Trigger webhook', () => {
	it('emits BSUID-only inbound messages (hidden phone) keyed on fromUserId', async () => {
		const out = await emitted(
			envelope({
				contacts: [
					{ profile: { name: 'Jane', username: 'jane_doe' }, user_id: 'BR.13491208655302741918' },
				],
				messages: [
					{
						id: 'wamid.bsuid1',
						from_user_id: 'BR.13491208655302741918',
						timestamp: '1720000000',
						type: 'text',
						text: { body: 'hi' },
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			fromUserId: 'BR.13491208655302741918',
			userId: 'BR.13491208655302741918',
			username: 'jane_doe',
			text: 'hi',
		});
		expect(out[0].from).toBeUndefined();
		expect(out[0].waId).toBeUndefined();
	});

	it('emits both identifier families when the phone is visible', async () => {
		const out = await emitted(
			envelope({
				contacts: [
					{
						profile: { name: 'Jane' },
						wa_id: '34680989836',
						user_id: 'ES.98765432109876543210',
						parent_user_id: 'ES.ENT.111222333',
					},
				],
				messages: [
					{
						id: 'wamid.vis1',
						from: '34680989836',
						from_user_id: 'ES.98765432109876543210',
						timestamp: '1720000001',
						type: 'text',
						text: { body: 'hola' },
					},
				],
			}),
		);
		expect(out[0]).toMatchObject({
			from: '34680989836',
			waId: '34680989836',
			fromUserId: 'ES.98765432109876543210',
			parentUserId: 'ES.ENT.111222333',
			timestamp: '2024-07-03T09:46:41.000Z',
		});
	});

	it('flattens phone-change system events', async () => {
		const out = await emitted(
			envelope({
				messages: [
					{
						id: 'wamid.sys1',
						timestamp: '1720000002',
						type: 'system',
						system: {
							body: 'User changed phone number',
							user_id: 'ES.98765432109876543210',
							new_user_id: 'ES.55555555555555555555',
						},
					},
				],
			}),
		);
		expect(out[0]).toMatchObject({
			type: 'system',
			oldUserId: 'ES.98765432109876543210',
			newUserId: 'ES.55555555555555555555',
		});
	});

	it('drops the business own outbound echoes', async () => {
		const out = await emitted(
			envelope({
				contacts: [{ profile: { name: 'Biz' }, wa_id: '4915199999999' }],
				messages: [
					{
						id: 'wamid.echo1',
						from: '4915199999999',
						timestamp: '1720000003',
						type: 'text',
						text: { body: 'auto-reply from the business' },
					},
				],
			}),
		);
		expect(out).toHaveLength(0);
	});

	it('ignores statuses-only payloads', async () => {
		const out = await emitted(
			envelope({
				statuses: [
					{
						id: 'wamid.st1',
						status: 'delivered',
						timestamp: '1720000004',
						recipient_user_id: 'BR.13491208655302741918',
					},
				],
			}),
		);
		expect(out).toHaveLength(0);
	});

	it('deduplicates redeliveries of the same wamid via static data', async () => {
		const staticData: IDataObject = {};
		const payload = envelope({
			contacts: [{ profile: { name: 'Jane' }, user_id: 'BR.13491208655302741918' }],
			messages: [
				{
					id: 'wamid.dup1',
					from_user_id: 'BR.13491208655302741918',
					timestamp: '1720000005',
					type: 'text',
					text: { body: 'once' },
				},
			],
		});
		expect(await emitted(payload, staticData)).toHaveLength(1);
		expect(await emitted(payload, staticData)).toHaveLength(0);
	});
});

const statusPayload = envelope({
	statuses: [
		{
			id: 'wamid.out1',
			status: 'delivered',
			timestamp: '1720000100',
			recipient_id: '491701234567',
			conversation: { id: 'conv1', origin: { type: 'service' } },
			pricing: { billable: false, category: 'service', pricing_model: 'PMP' },
		},
		{
			id: 'wamid.out2',
			status: 'failed',
			timestamp: '1720000200',
			recipient_id: '491701234567',
			errors: [{ code: 131047, title: 'Re-engagement message', message: 'More than 24 hours' }],
		},
	],
});

describe('Dialog360Trigger status updates', () => {
	it('ignores statuses unless Status Update is selected', async () => {
		expect(await emitted(statusPayload)).toHaveLength(0);
	});

	it('emits flattened statuses when selected', async () => {
		const out = await emitted(statusPayload, {}, { params: { events: ['statusUpdate'] } });
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			event: 'status',
			messageId: 'wamid.out1',
			status: 'delivered',
			recipientId: '491701234567',
			conversationCategory: 'service',
			billable: false,
			timestamp: new Date(1720000100 * 1000).toISOString(),
		});
		expect(out[1]).toMatchObject({ status: 'failed', errorCode: 131047, errorTitle: 'Re-engagement message' });
	});

	it('filters by status type', async () => {
		const out = await emitted(statusPayload, {}, {
			params: { events: ['statusUpdate'], statusTypes: ['failed'] },
		});
		expect(out.map((o) => o.messageId)).toEqual(['wamid.out2']);
	});

	it('does not emit messages when only Status Update is selected', async () => {
		const out = await emitted(
			envelope({
				contacts: [{ profile: { name: 'Jane' }, wa_id: '491701234567' }],
				messages: [{ id: 'wamid.in', from: '491701234567', timestamp: '1', type: 'text', text: { body: 'x' } }],
			}),
			{},
			{ params: { events: ['statusUpdate'] } },
		);
		expect(out).toHaveLength(0);
	});
});

describe('Dialog360Trigger signature verification', () => {
	const body = envelope({
		contacts: [{ profile: { name: 'Jane' }, wa_id: '491701234567' }],
		messages: [{ id: 'wamid.sig', from: '491701234567', timestamp: '1', type: 'text', text: { body: 'hi' } }],
	});
	const raw = Buffer.from(JSON.stringify(body));
	const sign = (secret: string) => createHmac('sha256', secret).update(raw).digest('hex');

	it('accepts a valid signature', async () => {
		const out = await emitted(body, {}, {
			secret: 's3cret',
			rawBody: raw,
			headers: { 'x-360dialog-signature': sign('s3cret') },
		});
		expect(out).toHaveLength(1);
	});

	it('rejects a wrong signature with 401 and does not start the workflow', async () => {
		const response: { statusCode?: number; body?: string } = {};
		const result = await trigger.webhook.call(
			makeContext(body, {}, {
				secret: 's3cret',
				rawBody: raw,
				headers: { 'x-360dialog-signature': sign('other') },
				response,
			}),
		);
		expect(response.statusCode).toBe(401);
		expect(result).toEqual({ noWebhookResponse: true });
	});

	it('rejects a missing signature with 401', async () => {
		const response: { statusCode?: number } = {};
		const result = await trigger.webhook.call(
			makeContext(body, {}, { secret: 's3cret', rawBody: raw, response }),
		);
		expect(response.statusCode).toBe(401);
		expect(result.workflowData).toBeUndefined();
	});

	it('skips verification when no secret is configured', async () => {
		expect(await emitted(body)).toHaveLength(1);
	});
});
