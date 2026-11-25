import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildComponents,
	buildList,
	buildReplyButtons,
	dialog360ApiRequest,
	fetchApprovedTemplates,
	mediaDownloadUrl,
	mediaFileName,
	recipientFields,
	simplifySendResponse,
	templateFieldDescriptors,
} from './GenericFunctions';
import type { ListRowInput, ReplyButtonInput } from './GenericFunctions';

// Two steps: GET /{media_id} for the metadata and a short-lived Meta CDN URL,
// then download the same path from 360dialog's host with the API key.
async function downloadMedia(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const mediaId = String(this.getNodeParameter('mediaId', i)).trim();
	if (!/^\d+$/.test(mediaId)) {
		throw new NodeOperationError(
			this.getNode(),
			`Media ID must be numeric (got "${mediaId}"). Use the imageId, videoId, audioId, documentId or stickerId output of the 360dialog Trigger.`,
			{ itemIndex: i },
		);
	}
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;

	const meta = await dialog360ApiRequest.call(this, 'GET', `/${mediaId}`);
	if (!meta.url) {
		throw new NodeOperationError(this.getNode(), `360dialog returned no download URL for media ${mediaId}`, {
			itemIndex: i,
		});
	}

	let data: Buffer;
	try {
		data = (await this.helpers.httpRequestWithAuthentication.call(this, 'dialog360Api', {
			method: 'GET',
			url: mediaDownloadUrl(String(meta.url)),
			encoding: 'arraybuffer',
			json: false,
		})) as Buffer;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: `Could not download media ${mediaId}`,
			description: 'Media can only be downloaded for 30 days after it was received.',
			itemIndex: i,
		});
	}

	const mimeType = meta.mime_type as string | undefined;
	const binary = await this.helpers.prepareBinaryData(
		Buffer.from(data),
		mediaFileName(mediaId, mimeType),
		mimeType,
	);
	return {
		json: {
			mediaId,
			mimeType,
			fileSize: meta.file_size,
			sha256: meta.sha256,
		},
		binary: { [binaryPropertyName]: binary },
		pairedItem: { item: i },
	};
}

// Programmatic style: Send Template requires dependent API calls (fetch the
// template definition, then reassemble Meta's components[] from flat inputs),
// which declarative routing cannot express.
export class Dialog360 implements INodeType {
	description: INodeTypeDescription = {
		displayName: '360dialog',
		name: 'dialog360',
		icon: { light: 'file:dialog360.svg', dark: 'file:dialog360.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send WhatsApp messages and manage media with the 360dialog Messaging API',
		defaults: {
			name: '360dialog',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dialog360Api',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Media', value: 'media' },
					{ name: 'Message', value: 'message' },
				],
				default: 'message',
			},

			// ----------------------------------
			//         message operations
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['message'],
					},
				},
				options: [
					{
						name: 'Mark as Read',
						value: 'markAsRead',
						description:
							'Mark an inbound message as read (blue ticks), optionally showing a typing indicator',
						action: 'Mark a message as read',
					},
					{
						name: 'Send Buttons',
						value: 'sendButtons',
						description: 'Send a message with up to 3 quick reply buttons',
						action: 'Send a reply buttons message',
					},
					{
						name: 'Send List',
						value: 'sendList',
						description: 'Send a message that opens a list of up to 10 options',
						action: 'Send a list message',
					},
					{
						name: 'Send Media',
						value: 'sendMedia',
						description: 'Send an image, video, document or audio message from a public URL',
						action: 'Send a media message',
					},
					{
						name: 'Send Template',
						value: 'sendTemplate',
						description:
							'Send an approved template message (works outside the 24-hour customer service window)',
						action: 'Send a template message',
					},
					{
						name: 'Send Text',
						value: 'sendText',
						description: 'Send a plain text message',
						action: 'Send a text message',
					},
				],
				default: 'sendText',
			},

			// ----------------------------------
			//         account operations
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['account'],
					},
				},
				options: [
					{
						name: 'Get Health Status',
						value: 'getHealthStatus',
						description: 'Check the health status of your Messaging API channel',
						action: 'Get the health status',
					},
				],
				default: 'getHealthStatus',
			},

			// ----------------------------------
			//         media operations
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['media'],
					},
				},
				options: [
					{
						name: 'Download',
						value: 'download',
						description: 'Download the file of an inbound image, video, audio, document or sticker',
						action: 'Download a media file',
					},
				],
				default: 'download',
			},
			{
				displayName: 'Media ID',
				name: 'mediaId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 1234567890123456',
				description:
					'ID of the media from the inbound message, for example the imageId or documentId output of the 360dialog Trigger. Media can be downloaded for 30 days after it was received.',
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['download'],
					},
				},
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				hint: 'The name of the output binary field to put the file in',
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['download'],
					},
				},
			},

			// ----------------------------------
			//         message:markAsRead
			// ----------------------------------
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. wamid.HBgMNDkxNzAxMjM0NTY3FQIAEhggQ0E...',
				description: 'ID of the inbound message, for example the messageId output of the 360dialog Trigger',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['markAsRead'],
					},
				},
			},
			{
				displayName: 'Show Typing Indicator',
				name: 'typingIndicator',
				type: 'boolean',
				default: false,
				description:
					'Whether to also show "typing…" to the user until you reply or for up to 25 seconds',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['markAsRead'],
					},
				},
			},

			// ----------------------------------
			//         shared: recipient
			// ----------------------------------
			{
				displayName: 'To (Phone Number)',
				name: 'to',
				type: 'string',
				default: '',
				placeholder: 'e.g. 491701234567',
				description:
					'Recipient phone number in international format, digits only (+, spaces and dashes are stripped automatically). Provide this, a Recipient user ID, or both — when both are set, the phone number takes precedence.',
				displayOptions: {
					show: {
						resource: ['message'],
					},
					hide: {
						operation: ['markAsRead'],
					},
				},
			},
			{
				displayName: 'Recipient (User ID)',
				name: 'recipient',
				type: 'string',
				default: '',
				placeholder: 'e.g. BR.13491208655302741918',
				description:
					'Business-Scoped User ID (BSUID) of the recipient, for users whose phone number is hidden behind a WhatsApp username. Provide this, a phone number, or both.',
				displayOptions: {
					show: {
						resource: ['message'],
					},
					hide: {
						operation: ['markAsRead'],
					},
				},
			},

			// ----------------------------------
			//         message:sendText
			// ----------------------------------
			{
				displayName: 'Message Text',
				name: 'body',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				required: true,
				default: '',
				description: 'The text content of the WhatsApp message to send',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendText'],
					},
				},
			},
			{
				displayName: 'Show Link Preview',
				name: 'previewUrl',
				type: 'boolean',
				default: false,
				description: 'Whether to render a preview card for the first URL in the message',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendText'],
					},
				},
			},

			// ----------------------------------
			//    message:sendButtons / sendList
			// ----------------------------------
			{
				displayName: 'Body Text',
				name: 'interactiveBody',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				required: true,
				default: '',
				description: 'Main text of the message (up to 1024 characters)',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendButtons', 'sendList'],
					},
				},
			},
			{
				displayName: 'Buttons',
				name: 'buttons',
				type: 'fixedCollection',
				placeholder: 'Add Button',
				typeOptions: {
					multipleValues: true,
					maxAllowedFields: 3,
				},
				required: true,
				default: {},
				description:
					'Up to 3 buttons. When the user taps one, the 360dialog Trigger outputs its ID as interactiveReplyId.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendButtons'],
					},
				},
				options: [
					{
						displayName: 'Button',
						name: 'button',
						values: [
							{
								displayName: 'Title',
								name: 'title',
								type: 'string',
								default: '',
								description: 'Button label (up to 20 characters)',
							},
							{
								displayName: 'ID',
								name: 'id',
								type: 'string',
								default: '',
								description:
									'Returned to your workflow when the user taps the button. Defaults to the title.',
							},
						],
					},
				],
			},
			{
				displayName: 'List Button Text',
				name: 'listButtonText',
				type: 'string',
				required: true,
				default: 'Options',
				description: 'Label of the button that opens the list (up to 20 characters)',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendList'],
					},
				},
			},
			{
				displayName: 'Rows',
				name: 'rows',
				type: 'fixedCollection',
				placeholder: 'Add Row',
				typeOptions: {
					multipleValues: true,
					maxAllowedFields: 10,
				},
				required: true,
				default: {},
				description:
					'Up to 10 options. Rows with the same Section are grouped together. When the user picks one, the 360dialog Trigger outputs its ID as interactiveReplyId.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendList'],
					},
				},
				options: [
					{
						displayName: 'Row',
						name: 'row',
						values: [
							{
								displayName: 'Title',
								name: 'title',
								type: 'string',
								default: '',
								description: 'Option label (up to 24 characters)',
							},
							{
								displayName: 'ID',
								name: 'id',
								type: 'string',
								default: '',
								description:
									'Returned to your workflow when the user picks this option. Defaults to the title.',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								description: 'Optional second line (up to 72 characters)',
							},
							{
								displayName: 'Section',
								name: 'section',
								type: 'string',
								default: '',
								description:
									'Optional section title (up to 24 characters). Required on every row once you use more than one section.',
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'interactiveOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendButtons', 'sendList'],
					},
				},
				options: [
					{
						displayName: 'Footer Text',
						name: 'footer',
						type: 'string',
						default: '',
						description: 'Small grey text under the body (up to 60 characters)',
					},
					{
						displayName: 'Header Text',
						name: 'header',
						type: 'string',
						default: '',
						description: 'Bold text above the body (up to 60 characters)',
					},
				],
			},

			// ----------------------------------
			//         message:sendMedia
			// ----------------------------------
			{
				displayName: 'Media Type',
				name: 'mediaType',
				type: 'options',
				options: [
					{ name: 'Audio', value: 'audio' },
					{ name: 'Document', value: 'document' },
					{ name: 'Image', value: 'image' },
					{ name: 'Video', value: 'video' },
				],
				default: 'image',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendMedia'],
					},
				},
			},
			{
				displayName: 'Media URL',
				name: 'link',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. https://example.com/image.jpg',
				description:
					'Publicly reachable HTTPS URL to the file. Signed or expiring URLs may fail.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendMedia'],
					},
				},
			},
			{
				displayName: 'Caption',
				name: 'caption',
				type: 'string',
				default: '',
				description: 'Optional caption shown under the media',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendMedia'],
						mediaType: ['image', 'video', 'document'],
					},
				},
			},
			{
				displayName: 'Filename',
				name: 'filename',
				type: 'string',
				default: '',
				placeholder: 'e.g. invoice.pdf',
				description: 'Filename shown to the recipient',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendMedia'],
						mediaType: ['document'],
					},
				},
			},

			// ----------------------------------
			//         message:sendTemplate
			// ----------------------------------
			{
				displayName: 'Template Name or ID',
				name: 'template',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTemplates',
				},
				required: true,
				default: '',
				description:
					'The approved template to send. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendTemplate'],
					},
				},
			},
			{
				displayName: 'Template Fields',
				name: 'templateFields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				typeOptions: {
					loadOptionsDependsOn: ['template'],
					resourceMapper: {
						resourceMapperMethod: 'getTemplateFields',
						mode: 'add',
						addAllFields: true,
						supportAutoMap: false,
						hideNoDataError: true,
						fieldWords: {
							singular: 'template field',
							plural: 'template fields',
						},
					},
				},
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['sendTemplate'],
					},
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const templates = await fetchApprovedTemplates.call(this);
				return templates
					.map((t) => ({
						name: `${t.name} — ${t.language} (${t.category ?? 'template'})`,
						value: `${t.name}|${t.language}`,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
		resourceMapping: {
			// Regenerates the Template Fields inputs whenever the selected
			// template changes (loadOptionsDependsOn: ['template']).
			async getTemplateFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const composite = this.getNodeParameter('template', '') as string;
				if (!composite) {
					return { fields: [] };
				}
				const [name, language] = composite.split('|');
				const templates = await fetchApprovedTemplates.call(this);
				const templateDef = templates.find((t) => t.name === name && t.language === language);
				if (!templateDef) {
					return { fields: [] };
				}
				return {
					fields: templateFieldDescriptors(templateDef).map((f) => ({
						id: f.id,
						displayName: f.label,
						required: f.required,
						defaultMatch: false,
						display: true,
						canBeUsedToMatch: false,
						type: 'string',
					})),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let responseData: IDataObject;

				if (resource === 'account' && operation === 'getHealthStatus') {
					responseData = await dialog360ApiRequest.call(this, 'GET', '/health_status');
				} else if (resource === 'media' && operation === 'download') {
					returnData.push(await downloadMedia.call(this, i));
					continue;
				} else if (resource === 'message' && operation === 'markAsRead') {
					const body: IDataObject = {
						messaging_product: 'whatsapp',
						status: 'read',
						message_id: String(this.getNodeParameter('messageId', i)).trim(),
					};
					if (this.getNodeParameter('typingIndicator', i, false) as boolean) {
						body.typing_indicator = { type: 'text' };
					}
					responseData = await dialog360ApiRequest.call(this, 'POST', '/messages', body);
				} else if (resource === 'message') {
					const { fields: recipient, error: recipientError } = recipientFields(
						this.getNodeParameter('to', i, '') as string,
						this.getNodeParameter('recipient', i, '') as string,
					);
					if (recipientError) {
						throw new NodeOperationError(this.getNode(), recipientError, { itemIndex: i });
					}

					if (operation === 'sendText') {
						responseData = await dialog360ApiRequest.call(this, 'POST', '/messages', {
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...recipient,
							type: 'text',
							text: {
								body: this.getNodeParameter('body', i) as string,
								preview_url: this.getNodeParameter('previewUrl', i) as boolean,
							},
						});
					} else if (operation === 'sendButtons' || operation === 'sendList') {
						const options = this.getNodeParameter('interactiveOptions', i, {}) as IDataObject;
						const common = {
							body: this.getNodeParameter('interactiveBody', i) as string,
							header: (options.header as string | undefined) || undefined,
							footer: (options.footer as string | undefined) || undefined,
						};
						let interactive: IDataObject;
						try {
							if (operation === 'sendButtons') {
								const collection = this.getNodeParameter('buttons', i, {}) as {
									button?: ReplyButtonInput[];
								};
								interactive = buildReplyButtons(common, collection.button ?? []);
							} else {
								const collection = this.getNodeParameter('rows', i, {}) as {
									row?: ListRowInput[];
								};
								interactive = buildList(
									common,
									this.getNodeParameter('listButtonText', i) as string,
									collection.row ?? [],
								);
							}
						} catch (error) {
							throw new NodeOperationError(this.getNode(), (error as Error).message, {
								itemIndex: i,
							});
						}
						responseData = await dialog360ApiRequest.call(this, 'POST', '/messages', {
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...recipient,
							type: 'interactive',
							interactive,
						});
					} else if (operation === 'sendMedia') {
						const mediaType = this.getNodeParameter('mediaType', i) as string;
						const media: IDataObject = { link: this.getNodeParameter('link', i) as string };
						if (['image', 'video', 'document'].includes(mediaType)) {
							const caption = this.getNodeParameter('caption', i, '') as string;
							if (caption) media.caption = caption;
						}
						if (mediaType === 'document') {
							const filename = this.getNodeParameter('filename', i, '') as string;
							if (filename) media.filename = filename;
						}
						responseData = await dialog360ApiRequest.call(this, 'POST', '/messages', {
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...recipient,
							type: mediaType,
							[mediaType]: media,
						});
					} else if (operation === 'sendTemplate') {
						const composite = this.getNodeParameter('template', i) as string;
						const [name, language] = composite.split('|');

						const templates = await fetchApprovedTemplates.call(this);
						const templateDef = templates.find(
							(t) => t.name === name && t.language === language,
						);
						if (!templateDef) {
							throw new NodeOperationError(
								this.getNode(),
								`Template "${name}" (${language}) was not found or is not approved. Only approved templates can be sent.`,
								{ itemIndex: i },
							);
						}

						const mapper = this.getNodeParameter('templateFields', i, {}) as IDataObject;
						const values = (mapper.value ?? {}) as Record<string, string>;

						const components = buildComponents(templateDef, values);
						const template: IDataObject = { name, language: { code: language } };
						if (components.length) {
							template.components = components;
						}

						responseData = await dialog360ApiRequest.call(this, 'POST', '/messages', {
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...recipient,
							type: 'template',
							template,
						});
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
							itemIndex: i,
						});
					}

					responseData = simplifySendResponse(responseData);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, {
						itemIndex: i,
					});
				}

				returnData.push({
					json: responseData,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// dialog360ApiRequest already wraps API failures in NodeApiError.
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- already a wrapped n8n error; re-wrapping would mangle it
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
