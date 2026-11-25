/* eslint-disable @n8n/community-nodes/no-restricted-imports -- vitest is a devDependency; tests are excluded from the published package (files: ["dist"]) */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	buildComponents,
	buildList,
	buildReplyButtons,
	epochToIso,
	isValidSignature,
	mediaDownloadUrl,
	mediaFileName,
	extractVariables,
	isBsuid,
	isPositional,
	normalizePhone,
	recipientFields,
	simplifySendResponse,
	templateFieldDescriptors,
	type TemplateDef,
} from '../nodes/Dialog360/GenericFunctions';

describe('normalizePhone', () => {
	it('strips +, spaces, dashes and parentheses', () => {
		expect(normalizePhone('+49 (170) 123-4567')).toBe('491701234567');
	});
});

describe('epochToIso', () => {
	it('converts WhatsApp epoch seconds to ISO-8601 UTC', () => {
		expect(epochToIso('1720000000')).toBe('2024-07-03T09:46:40.000Z');
	});

	it('passes through already-formatted values and empties', () => {
		expect(epochToIso('2024-07-03T09:46:40Z')).toBe('2024-07-03T09:46:40Z');
		expect(epochToIso('')).toBeUndefined();
	});
});

describe('isBsuid', () => {
	it('accepts BSUIDs and parent BSUIDs', () => {
		expect(isBsuid('BR.13491208655302741918')).toBe(true);
		expect(isBsuid('ES.ENT.12345')).toBe(true);
	});

	it('rejects phone numbers and junk', () => {
		expect(isBsuid('491701234567')).toBe(false);
		expect(isBsuid('BR.')).toBe(false);
		expect(isBsuid('')).toBe(false);
	});
});

describe('recipientFields', () => {
	it('routes phones to `to`, normalized', () => {
		expect(recipientFields('+49 170 1234567', '')).toEqual({
			fields: { to: '491701234567' },
		});
	});

	it('routes BSUIDs to `recipient`', () => {
		expect(recipientFields('', 'BR.13491208655302741918')).toEqual({
			fields: { recipient: 'BR.13491208655302741918' },
		});
	});

	it('includes both when both are provided', () => {
		expect(recipientFields('491701234567', 'BR.13491208655302741918')).toEqual({
			fields: { to: '491701234567', recipient: 'BR.13491208655302741918' },
		});
	});

	it('errors when neither is provided', () => {
		expect(recipientFields('', '').error).toMatch(/Provide a phone number/);
	});

	it('errors on misplaced identifiers', () => {
		expect(recipientFields('BR.13491208655302741918', '').error).toMatch(/digits only/);
		expect(recipientFields('', '491701234567').error).toMatch(/Business-Scoped User ID/);
	});
});

describe('extractVariables / isPositional', () => {
	it('extracts positional and named variables', () => {
		expect(extractVariables('Hi {{1}}, order {{order_id}} ships {{2}}.')).toEqual([
			'1',
			'order_id',
			'2',
		]);
		expect(isPositional('1')).toBe(true);
		expect(isPositional('order_id')).toBe(false);
	});
});

const templateDef: TemplateDef = {
	name: 'order_update',
	language: 'en_US',
	status: 'APPROVED',
	components: [
		{ type: 'HEADER', format: 'IMAGE' },
		{ type: 'BODY', text: 'Hi {{1}}, order {{order_id}} ships {{2}}.' },
		{
			type: 'BUTTONS',
			buttons: [
				{ type: 'QUICK_REPLY', text: 'Stop' },
				{ type: 'URL', text: 'Track', url: 'https://x.com/{{1}}' },
				{ type: 'COPY_CODE', text: 'Copy code' },
			],
		},
		{ type: 'FOOTER', text: 'bye' },
	],
};

describe('templateFieldDescriptors', () => {
	it('generates one field per fillable slot with stable ids', () => {
		const ids = templateFieldDescriptors(templateDef).map((f) => f.id);
		expect(ids).toEqual([
			'header_media_url',
			'body_1',
			'body_order_id',
			'body_2',
			'button_1_url',
			'button_2_copy_code',
		]);
	});

	it('generates no fields for a variable-free template', () => {
		expect(
			templateFieldDescriptors({
				name: 't',
				language: 'en',
				status: 'APPROVED',
				components: [{ type: 'BODY', text: 'Static reminder.' }],
			}),
		).toEqual([]);
	});
});

describe('buildComponents', () => {
	it('assembles header, positional/named body params and buttons', () => {
		expect(
			buildComponents(templateDef, {
				header_media_url: 'https://cdn.example.com/a.jpg',
				body_1: 'Jane',
				body_order_id: 'A-1',
				body_2: 'Friday',
				button_1_url: 'code 25|x',
				button_2_copy_code: '25OFF',
			}),
		).toEqual([
			{
				type: 'header',
				parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/a.jpg' } }],
			},
			{
				type: 'body',
				parameters: [
					{ type: 'text', text: 'Jane' },
					{ type: 'text', text: 'A-1', parameter_name: 'order_id' },
					{ type: 'text', text: 'Friday' },
				],
			},
			{
				type: 'button',
				sub_type: 'url',
				index: '1',
				// percent-encoded: Meta rejects unencoded specials
				parameters: [{ type: 'text', text: 'code%2025%7Cx' }],
			},
			{
				type: 'button',
				sub_type: 'copy_code',
				index: '2',
				parameters: [{ type: 'coupon_code', coupon_code: '25OFF' }],
			},
		]);
	});

	it('returns an empty array for a no-params template', () => {
		expect(
			buildComponents(
				{
					name: 't',
					language: 'en',
					status: 'APPROVED',
					components: [{ type: 'BODY', text: 'Static.' }, { type: 'FOOTER', text: 'bye' }],
				},
				{},
			),
		).toEqual([]);
	});
});

describe('simplifySendResponse', () => {
	it('exposes wa_id for phone-addressed sends', () => {
		expect(
			simplifySendResponse({
				contacts: [{ input: '491701234567', wa_id: '491701234567' }],
				messages: [{ id: 'wamid.a' }],
			}),
		).toMatchObject({ messageId: 'wamid.a', waId: '491701234567', userId: undefined });
	});

	it('exposes user_id for BSUID-addressed sends', () => {
		expect(
			simplifySendResponse({
				contacts: [{ input: 'BR.134', user_id: 'BR.134' }],
				messages: [{ id: 'wamid.b' }],
			}),
		).toMatchObject({ messageId: 'wamid.b', waId: undefined, userId: 'BR.134' });
	});
});

describe('interactive builders', () => {
	it('builds reply buttons, defaulting IDs to titles', () => {
		const out = buildReplyButtons({ body: 'Pick one', footer: 'f' }, [
			{ title: 'Yes', id: 'yes' },
			{ title: 'No' },
		]);
		expect(out).toEqual({
			type: 'button',
			body: { text: 'Pick one' },
			footer: { text: 'f' },
			action: {
				buttons: [
					{ type: 'reply', reply: { id: 'yes', title: 'Yes' } },
					{ type: 'reply', reply: { id: 'No', title: 'No' } },
				],
			},
		});
	});

	it('rejects more than 3 buttons, long titles, duplicates and empty body', () => {
		const four = [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }];
		expect(() => buildReplyButtons({ body: 'x' }, four)).toThrow(/at most 3/);
		expect(() => buildReplyButtons({ body: 'x' }, [{ title: 'x'.repeat(21) }])).toThrow(/at most 20/);
		expect(() => buildReplyButtons({ body: 'x' }, [{ title: 'a', id: '1' }, { title: 'b', id: '1' }])).toThrow(
			/unique/,
		);
		expect(() => buildReplyButtons({ body: ' ' }, [{ title: 'a' }])).toThrow(/Body text/);
	});

	it('groups list rows into sections in order of appearance', () => {
		const out = buildList({ body: 'Menu', header: 'Hi' }, 'Open', [
			{ title: 'Pizza', section: 'Food', description: 'Hot' },
			{ title: 'Water', section: 'Drinks' },
			{ title: 'Pasta', section: 'Food', id: 'pasta' },
		]);
		expect(out).toEqual({
			type: 'list',
			header: { type: 'text', text: 'Hi' },
			body: { text: 'Menu' },
			action: {
				button: 'Open',
				sections: [
					{
						title: 'Food',
						rows: [
							{ id: 'Pizza', title: 'Pizza', description: 'Hot' },
							{ id: 'pasta', title: 'Pasta' },
						],
					},
					{ title: 'Drinks', rows: [{ id: 'Water', title: 'Water' }] },
				],
			},
		});
	});

	it('builds a single untitled section', () => {
		const out = buildList({ body: 'Menu' }, 'Open', [{ title: 'A' }]);
		expect((out.action as { sections: unknown[] }).sections).toEqual([{ rows: [{ id: 'A', title: 'A' }] }]);
	});

	it('rejects mixed titled and untitled sections and more than 10 rows', () => {
		expect(() => buildList({ body: 'x' }, 'Open', [{ title: 'A', section: 'S' }, { title: 'B' }])).toThrow(
			/every row needs a section/,
		);
		const eleven = Array.from({ length: 11 }, (_, n) => ({ title: `r${n}` }));
		expect(() => buildList({ body: 'x' }, 'Open', eleven)).toThrow(/at most 10/);
	});
});

describe('media download helpers', () => {
	it('moves the Meta CDN URL onto the 360dialog host and strips backslashes', () => {
		expect(
			mediaDownloadUrl(
				'https:\\/\\/lookaside.fbsbx.com\\/whatsapp_business\\/attachments\\/?mid=13&ext=16&hash=AT',
			),
		).toBe('https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=13&ext=16&hash=AT');
	});

	it('never keeps a foreign host', () => {
		expect(mediaDownloadUrl('https://evil.example.com/x?y=1')).toBe('https://waba-v2.360dialog.io/x?y=1');
	});

	it('derives file names from MIME types', () => {
		expect(mediaFileName('1', 'image/jpeg')).toBe('1.jpg');
		expect(mediaFileName('2', 'audio/ogg; codecs=opus')).toBe('2.ogg');
		expect(mediaFileName('3', undefined)).toBe('3');
	});
});

describe('isValidSignature', () => {
	const body = '{"a":1}';
	const good = createHmac('sha256', 'k').update(body).digest('hex');

	it('accepts the hex HMAC, with or without a sha256= prefix', () => {
		expect(isValidSignature(body, good, 'k')).toBe(true);
		expect(isValidSignature(Buffer.from(body), `sha256=${good.toUpperCase()}`, 'k')).toBe(true);
	});

	it('rejects wrong, malformed or missing signatures', () => {
		expect(isValidSignature(body, good, 'other')).toBe(false);
		expect(isValidSignature(body, 'abc', 'k')).toBe(false);
		expect(isValidSignature(body, undefined, 'k')).toBe(false);
		expect(isValidSignature(body, good, '')).toBe(false);
	});
});
