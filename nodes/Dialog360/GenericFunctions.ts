import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const BASE_URL = 'https://waba-v2.360dialog.io';

export async function dialog360ApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<IDataObject> {
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, 'dialog360Api', {
			method,
			url: `${BASE_URL}${endpoint}`,
			body,
			json: true,
		})) as IDataObject;
	} catch (error) {
		const causeText = JSON.stringify((error as JsonObject).cause ?? {});
		// 131047: free-form message outside the 24h customer service window.
		if (causeText.includes('131047')) {
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'The 24-hour customer service window for this recipient has closed',
				description: 'Use the Send Template operation to re-engage this recipient.',
			});
		}
		// 131009: malformed, foreign-portfolio or retired BSUID.
		if (causeText.includes('131009')) {
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'The recipient identifier was rejected (error 131009)',
				description:
					'If you sent to a user ID (BSUID), it may be malformed, belong to another business portfolio, or have been retired by a phone change. Re-resolve the identity — watch for "system" events on the 360dialog Trigger announcing a new user ID.',
			});
		}
		// 131062: authentication templates cannot be sent to a BSUID.
		if (causeText.includes('131062')) {
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'Authentication templates cannot be sent to a user ID (error 131062)',
				description: 'Address this recipient by phone number to send authentication templates.',
			});
		}
		// Surface 360dialog's own error text instead of a generic status message.
		const cause = ((error as IDataObject).cause ?? error) as IDataObject;
		const response = (cause.response ?? {}) as IDataObject;
		const responseBody = response.body ?? response.data ?? cause.errorResponse;
		if (responseBody) {
			const apiMessage =
				typeof responseBody === 'string'
					? responseBody
					: String(
							(responseBody as IDataObject).error ??
								((responseBody as IDataObject).meta as IDataObject | undefined)
									?.developer_message ??
								JSON.stringify(responseBody),
						);
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: `360dialog error: ${apiMessage}`,
			});
		}
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

// WhatsApp expects digits only: no +, spaces, dashes or parentheses.
export function normalizePhone(raw: string): string {
	return String(raw ?? '').replace(/[+\s\-()]/g, '');
}

// Business-Scoped User ID: XX.<18-20 digits>, or XX.ENT.<digits> for parent
// BSUIDs.
export function isBsuid(value: string): boolean {
	return /^[A-Z]{2}\.(ENT\.)?\d+$/i.test(String(value ?? '').trim());
}

// POST /messages addresses phones via `to` and/or BSUIDs via `recipient`;
// at least one must be provided (when both are set, the API lets `to` win).
// Returns the payload fields, or an error string describing what's wrong.
export function recipientFields(
	rawTo: string,
	rawRecipient: string,
): { fields?: IDataObject; error?: string } {
	const to = normalizePhone(String(rawTo ?? '').trim());
	const recipient = String(rawRecipient ?? '').trim();

	if (!to && !recipient) {
		return { error: 'Provide a phone number ("To") and/or a user ID ("Recipient")' };
	}
	if (to && !/^\d+$/.test(to)) {
		return {
			error: `"To" must be a phone number in international format, digits only (got "${rawTo}"). User IDs (BSUIDs) go into the "Recipient" field.`,
		};
	}
	if (recipient && !isBsuid(recipient)) {
		return {
			error: `"Recipient" must be a Business-Scoped User ID like BR.13491208655302741918 (got "${rawRecipient}"). Phone numbers go into the "To" field.`,
		};
	}

	const fields: IDataObject = {};
	if (to) fields.to = to;
	if (recipient) fields.recipient = recipient;
	return { fields };
}

// WhatsApp webhooks carry timestamps as Unix epoch seconds.
export function epochToIso(ts: unknown): string | undefined {
	if (ts === null || ts === undefined || ts === '') return undefined;
	if (/^\d+$/.test(String(ts))) {
		return new Date(Number(ts) * 1000).toISOString();
	}
	return String(ts);
}

// Returns the raw variable tokens from a template string, e.g.
// "Use {{1}} by {{expiry_date}}" -> ['1', 'expiry_date'].
export function extractVariables(text?: string): string[] {
	const vars: string[] = [];
	const re = /\{\{\s*([^}]+?)\s*\}\}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text ?? '')) !== null) {
		vars.push(match[1]);
	}
	return vars;
}

// Positional params ({{1}}) vs Meta named params ({{order_id}}).
export function isPositional(variable: string): boolean {
	return /^\d+$/.test(variable);
}

export interface TemplateComponentDef {
	type: string;
	format?: string;
	text?: string;
	url?: string;
	buttons?: Array<{ type: string; text?: string; url?: string }>;
	example?: IDataObject;
}

export interface TemplateDef {
	name: string;
	language: string;
	status: string;
	category?: string;
	components?: TemplateComponentDef[];
}

const MAX_TEMPLATE_PAGES = 20;

// GET /message_templates returns { data: [...], paging: { cursors, next } }.
export async function fetchApprovedTemplates(
	this: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<TemplateDef[]> {
	const all: TemplateDef[] = [];
	let after: string | undefined;

	for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
		const endpoint = after
			? `/message_templates?after=${encodeURIComponent(after)}`
			: '/message_templates';
		const response = await dialog360ApiRequest.call(this, 'GET', endpoint);
		all.push(...(((response.data as TemplateDef[] | undefined) ?? []) as TemplateDef[]));

		const paging = response.paging as IDataObject | undefined;
		const cursors = paging?.cursors as IDataObject | undefined;
		after = paging?.next ? (cursors?.after as string | undefined) : undefined;
		if (!after) break;
	}

	return all.filter((t) => String(t.status).toUpperCase() === 'APPROVED');
}

export interface TemplateFieldDescriptor {
	id: string;
	label: string;
	required: boolean;
}

const hasVariable = (text?: string): boolean => /\{\{.+?\}\}/.test(text ?? '');

const truncate = (text: string, max = 60): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

// One input field per fillable slot in the template. The ids are stable keys
// that buildComponents() maps back onto Meta's components[] format.
export function templateFieldDescriptors(templateDef: TemplateDef): TemplateFieldDescriptor[] {
	const fields: TemplateFieldDescriptor[] = [];

	for (const c of templateDef.components ?? []) {
		const ctype = String(c.type ?? '').toUpperCase();

		if (ctype === 'BODY') {
			for (const v of extractVariables(c.text)) {
				fields.push({
					id: `body_${v}`,
					label: isPositional(v)
						? `Body {{${v}}} — “${truncate(c.text ?? '')}”`
						: `Body: ${v}`,
					required: true,
				});
			}
		} else if (ctype === 'HEADER') {
			const format = String(c.format ?? 'TEXT').toUpperCase();
			if (format === 'TEXT') {
				const vars = extractVariables(c.text);
				if (vars.length) {
					fields.push({
						id: 'header_text',
						label: `Header {{${vars[0]}}} — “${truncate(c.text ?? '')}”`,
						required: true,
					});
				}
			} else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
				fields.push({
					id: 'header_media_url',
					label: `Header ${format.toLowerCase()} URL`,
					required: true,
				});
			}
		} else if (ctype === 'BUTTONS') {
			(c.buttons ?? []).forEach((btn, index) => {
				const btype = String(btn.type ?? '').toUpperCase();
				if (btype === 'URL' && hasVariable(btn.url)) {
					fields.push({
						id: `button_${index}_url`,
						label: `Button “${btn.text ?? index}” URL variable`,
						required: true,
					});
				} else if (btype === 'COPY_CODE') {
					fields.push({
						id: `button_${index}_copy_code`,
						label: `Button “${btn.text ?? index}” coupon code`,
						required: true,
					});
				}
			});
		}
		// FOOTER and static components need no input.
	}

	return fields;
}

function textParam(variable: string, value: string): IDataObject {
	const param: IDataObject = { type: 'text', text: value ?? '' };
	if (!isPositional(variable)) {
		param.parameter_name = variable;
	}
	return param;
}

// Reassembles the values collected for templateFieldDescriptors() ids into
// Meta's components[] send format. Components without parameters are omitted.
export function buildComponents(
	templateDef: TemplateDef,
	values: Record<string, string>,
): IDataObject[] {
	const components: IDataObject[] = [];

	for (const c of templateDef.components ?? []) {
		const ctype = String(c.type ?? '').toUpperCase();

		if (ctype === 'BODY') {
			const vars = extractVariables(c.text);
			if (vars.length) {
				components.push({
					type: 'body',
					parameters: vars.map((v) => textParam(v, String(values[`body_${v}`] ?? ''))),
				});
			}
		} else if (ctype === 'HEADER') {
			const format = String(c.format ?? 'TEXT').toUpperCase();

			if (format === 'TEXT') {
				const vars = extractVariables(c.text);
				if (vars.length && values.header_text) {
					components.push({
						type: 'header',
						parameters: [textParam(vars[0], String(values.header_text))],
					});
				}
			} else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format) && values.header_media_url) {
				const mediaKey = format.toLowerCase();
				components.push({
					type: 'header',
					parameters: [{ type: mediaKey, [mediaKey]: { link: values.header_media_url } }],
				});
			}
		} else if (ctype === 'BUTTONS') {
			(c.buttons ?? []).forEach((btn, index) => {
				const btype = String(btn.type ?? '').toUpperCase();
				const urlValue = values[`button_${index}_url`];
				const codeValue = values[`button_${index}_copy_code`];

				if (btype === 'URL' && hasVariable(btn.url) && urlValue) {
					components.push({
						type: 'button',
						sub_type: 'url',
						index: String(index),
						// Meta rejects unencoded specials in dynamic URL-button values.
						parameters: [{ type: 'text', text: encodeURIComponent(urlValue) }],
					});
				} else if (btype === 'COPY_CODE' && codeValue) {
					components.push({
						type: 'button',
						sub_type: 'copy_code',
						index: String(index),
						parameters: [{ type: 'coupon_code', coupon_code: codeValue }],
					});
				}
			});
		}
		// FOOTER and other static components take no parameters.
	}

	return components;
}

// Flattens a message send response, exposing the ids downstream steps need.
// Phone-addressed sends return contacts[0].wa_id, BSUID-addressed sends
// return contacts[0].user_id — never both.
export function simplifySendResponse(response: IDataObject): IDataObject {
	const messages = response.messages as IDataObject[] | undefined;
	const contacts = response.contacts as IDataObject[] | undefined;
	return {
		...response,
		messageId: messages?.[0]?.id,
		waId: contacts?.[0]?.wa_id,
		userId: contacts?.[0]?.user_id,
	};
}

// WhatsApp's limits for interactive messages. Breaking them returns a generic
// 131009 "parameter value is not valid", so check them here with a clear error.
export const INTERACTIVE_LIMITS = {
	bodyText: 1024,
	headerText: 60,
	footerText: 60,
	buttons: 3,
	buttonId: 256,
	buttonTitle: 20,
	listButtonText: 20,
	listRows: 10,
	listSections: 10,
	rowId: 200,
	rowTitle: 24,
	rowDescription: 72,
	sectionTitle: 24,
} as const;

export interface InteractiveCommon {
	body: string;
	header?: string;
	footer?: string;
}

export interface ReplyButtonInput {
	id?: string;
	title: string;
}

export interface ListRowInput {
	id?: string;
	title: string;
	description?: string;
	section?: string;
}

function checkLength(label: string, value: string | undefined, max: number): void {
	if (value && [...value].length > max) {
		throw new Error(`${label} is ${[...value].length} characters; WhatsApp allows at most ${max}`);
	}
}

function interactiveFrame(common: InteractiveCommon): IDataObject {
	const body = String(common.body ?? '').trim();
	if (!body) {
		throw new Error('Body text is required for interactive messages');
	}
	checkLength('Body text', body, INTERACTIVE_LIMITS.bodyText);
	checkLength('Header text', common.header, INTERACTIVE_LIMITS.headerText);
	checkLength('Footer text', common.footer, INTERACTIVE_LIMITS.footerText);

	const frame: IDataObject = { body: { text: body } };
	if (common.header) frame.header = { type: 'text', text: common.header };
	if (common.footer) frame.footer = { text: common.footer };
	return frame;
}

// Builds `interactive` for type=button (up to 3 quick reply buttons). A button
// without an ID gets its title as ID, so the trigger's interactiveReplyId is
// always set.
export function buildReplyButtons(
	common: InteractiveCommon,
	buttons: ReplyButtonInput[],
): IDataObject {
	const frame = interactiveFrame(common);
	const clean = buttons.filter((b) => String(b.title ?? '').trim());
	if (clean.length === 0) {
		throw new Error('Add at least one button');
	}
	if (clean.length > INTERACTIVE_LIMITS.buttons) {
		throw new Error(
			`WhatsApp allows at most ${INTERACTIVE_LIMITS.buttons} reply buttons; use a list message for more options`,
		);
	}
	const ids = new Set<string>();
	const replies = clean.map((b) => {
		const title = b.title.trim();
		const id = String(b.id ?? '').trim() || title;
		checkLength(`Button title "${title}"`, title, INTERACTIVE_LIMITS.buttonTitle);
		checkLength(`Button ID "${id}"`, id, INTERACTIVE_LIMITS.buttonId);
		if (ids.has(id)) throw new Error(`Button IDs must be unique ("${id}" is used twice)`);
		ids.add(id);
		return { type: 'reply', reply: { id, title } };
	});
	return { type: 'button', ...frame, action: { buttons: replies } };
}

// Builds `interactive` for type=list. Rows are grouped into sections by their
// `section` field in the order the sections first appear. WhatsApp requires a
// section title once there is more than one section.
export function buildList(
	common: InteractiveCommon,
	buttonText: string,
	rows: ListRowInput[],
): IDataObject {
	const frame = interactiveFrame(common);
	const label = String(buttonText ?? '').trim();
	if (!label) throw new Error('Button text (the label that opens the list) is required');
	checkLength('List button text', label, INTERACTIVE_LIMITS.listButtonText);

	const clean = rows.filter((r) => String(r.title ?? '').trim());
	if (clean.length === 0) throw new Error('Add at least one list row');
	if (clean.length > INTERACTIVE_LIMITS.listRows) {
		throw new Error(`WhatsApp allows at most ${INTERACTIVE_LIMITS.listRows} rows in a list`);
	}

	const sections = new Map<string, IDataObject[]>();
	const ids = new Set<string>();
	for (const r of clean) {
		const title = r.title.trim();
		const id = String(r.id ?? '').trim() || title;
		const description = String(r.description ?? '').trim();
		checkLength(`Row title "${title}"`, title, INTERACTIVE_LIMITS.rowTitle);
		checkLength(`Row ID "${id}"`, id, INTERACTIVE_LIMITS.rowId);
		checkLength(`Row description for "${title}"`, description, INTERACTIVE_LIMITS.rowDescription);
		if (ids.has(id)) throw new Error(`Row IDs must be unique ("${id}" is used twice)`);
		ids.add(id);

		const section = String(r.section ?? '').trim();
		checkLength(`Section title "${section}"`, section, INTERACTIVE_LIMITS.sectionTitle);
		const row: IDataObject = { id, title };
		if (description) row.description = description;
		sections.set(section, [...(sections.get(section) ?? []), row]);
	}

	if (sections.size > INTERACTIVE_LIMITS.listSections) {
		throw new Error(`WhatsApp allows at most ${INTERACTIVE_LIMITS.listSections} sections in a list`);
	}
	if (sections.size > 1 && sections.has('')) {
		throw new Error('When rows use more than one section, every row needs a section title');
	}

	return {
		type: 'list',
		...frame,
		action: {
			button: label,
			sections: [...sections.entries()].map(([title, sectionRows]) =>
				title ? { title, rows: sectionRows } : { rows: sectionRows },
			),
		},
	};
}

// GET /{media_id} returns a Meta CDN URL (lookaside.fbsbx.com). 360dialog serves
// the same path and query on its own host, authenticated with D360-API-KEY.
// Only ever return a URL on BASE_URL so the API key never leaves 360dialog.
export function mediaDownloadUrl(metaUrl: string): string {
	const parsed = new URL(String(metaUrl ?? '').replace(/\\/g, ''));
	return `${BASE_URL}${parsed.pathname}${parsed.search}`;
}

export function mediaFileName(mediaId: string, mimeType?: string): string {
	const subtype = String(mimeType ?? '')
		.split(';')[0]
		.split('/')[1]
		?.trim();
	const ext = subtype ? `.${subtype === 'jpeg' ? 'jpg' : subtype.replace(/^x-/, '')}` : '';
	return `${mediaId}${ext}`;
}

export const SIGNATURE_HEADER = 'x-360dialog-signature';

// 360dialog signs channel webhooks with x-360dialog-signature: the hex
// HMAC-SHA256 of the raw request body, keyed with the platform secret.
// Compares in constant time. Accepts an optional "sha256=" prefix.
export function isValidSignature(
	rawBody: Buffer | string,
	signature: string | string[] | undefined,
	secret: string,
): boolean {
	const header = Array.isArray(signature) ? signature[0] : signature;
	if (!header || !secret) return false;
	const received = header.trim().replace(/^sha256=/i, '').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(received)) return false;
	const expected = createHmac('sha256', secret).update(rawBody).digest();
	return timingSafeEqual(expected, Buffer.from(received, 'hex'));
}

// Flattens one entry of value.statuses[] for the trigger's Status Update event.
export function flattenStatus(status: IDataObject, metadata: IDataObject = {}): IDataObject {
	const conversation = (status.conversation as IDataObject | undefined) ?? {};
	const origin = (conversation.origin as IDataObject | undefined) ?? {};
	const pricing = (status.pricing as IDataObject | undefined) ?? {};
	const errors = (status.errors as IDataObject[] | undefined) ?? [];
	const firstError = errors[0] ?? {};
	const errorData = (firstError.error_data as IDataObject | undefined) ?? {};

	const flat: IDataObject = {
		event: 'status',
		messageId: status.id,
		status: status.status,
		timestamp: epochToIso(status.timestamp),
		recipientId: status.recipient_id,
		recipientUserId: status.recipient_user_id,
		businessPhoneNumber: metadata.display_phone_number,
		phoneNumberId: metadata.phone_number_id,
		conversationId: conversation.id,
		conversationCategory: origin.type,
		billable: pricing.billable,
		pricingCategory: pricing.category,
		pricingModel: pricing.pricing_model,
	};
	if (errors.length) {
		flat.errorCode = firstError.code;
		flat.errorTitle = firstError.title;
		flat.errorMessage = firstError.message ?? errorData.details;
		flat.errors = errors;
	}
	return flat;
}
