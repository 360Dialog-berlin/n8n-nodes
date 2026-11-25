# n8n-nodes-360dialog

This is an n8n community node for the [360dialog](https://www.360dialog.com/) WhatsApp Business Messaging API. It lets you send WhatsApp messages from your workflows and trigger workflows when WhatsApp messages arrive.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Credentials](#credentials)
[Operations](#operations)
[Trigger](#trigger)
[Compatibility](#compatibility)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `@360dialog/n8n-nodes-360dialog`.

### Migrating from `@pmartino/n8n-nodes-360dialog`

This package replaces `@pmartino/n8n-nodes-360dialog`, which is no longer maintained. n8n identifies nodes by package name, so existing workflows don't switch over by themselves: Install this package, replace the old 360dialog and 360dialog Trigger nodes in each workflow (the parameters are the same, except that the trigger's **Event** is now a multi-select called **Events**), then uninstall the old package.

## Credentials

Create a **360dialog API** credential with your Messaging API key. Generate or copy the key in the [360dialog Hub](https://hub.360dialog.com/) under WhatsApp Accounts → API Keys. The key is sent as the `D360-API-KEY` header on every request, and the credential test calls the `/health_status` endpoint.

**Webhook Secret** is optional. Use your platform secret from the 360dialog Hub (the Hub shows it only once, like an API key). When it's set, the 360dialog Trigger checks the `x-360dialog-signature` header and answers requests with a missing or wrong signature with 401 without starting the workflow.

## Operations

The **360dialog** node supports:

### Message

- **Send Text** — plain text message with an optional link preview.
- **Send Media** — image, video, document or audio from a publicly reachable HTTPS URL, with optional caption and (for documents) filename.
- **Send Buttons** — a message with up to 3 quick reply buttons, with optional header and footer text. Each button has a title and an ID; a button without an ID uses its title.
- **Send List** — a message with a button that opens a list of up to 10 rows. Rows with the same **Section** are grouped together. Each row has a title, an optional description and an ID.
- **Mark as Read** — marks an inbound message as read (blue ticks), and can show a typing indicator until you reply or for up to 25 seconds.
- **Send Template** — approved template messages, usable outside the 24-hour customer service window. Pick the template from a live dropdown (approved templates only, one entry per name + language) and the node generates the input fields automatically from the template definition (`/message_templates`): one field per body variable (positional `{{1}}` or named `{{order_id}}`), header text variable or header media URL, and dynamic URL button / copy-code coupon values. Meta's `components[]` payload is assembled for you — URL button values are percent-encoded automatically.

Button and list limits are checked before sending, so you get a clear error instead of Meta's generic error 131009.

When the user taps a button or picks a list row, the 360dialog Trigger outputs its ID as `interactiveReplyId` and its title as `interactiveReplyTitle`.

### Media

- **Download** — downloads the file of an inbound image, video, audio, document or sticker into a binary field (`data` by default). Use the trigger's `imageId`, `videoId`, `audioId`, `documentId` or `stickerId` as the Media ID. Inbound media can be downloaded for 30 days.

### Account

- **Get Health Status** — checks the health of your Messaging API channel.

Recipient phone numbers are normalized automatically (leading `+`, spaces, dashes and parentheses are stripped).

If a free-form message is rejected because the 24-hour customer service window has closed (error 131047), the node surfaces a clear error suggesting the Send Template operation.

## Trigger

The **360dialog Trigger** node starts a workflow on the events you select:

- **Message Received** — a WhatsApp user sent a message to your number. Items have `event: "message"`.
- **Status Update** — a message you sent was sent, delivered, read or failed. Items have `event: "status"`, the `messageId` of your message, `status`, `recipientId`, conversation and pricing fields, and for failures `errorCode`, `errorTitle` and `errorMessage`. **Status Types** limits which statuses start the workflow.

- **Webhook lifecycle**: 360dialog delivers events to a single webhook URL per number (`POST /v1/configs/webhook`). Activating the workflow points that webhook at n8n and remembers the previously configured URL; deactivating restores it. Only one active consumer per number can receive events at a time.
- **Outbound echo filtering**: the webhook also carries the business's own outbound messages — these are dropped, so workflows that reply to messages don't trigger themselves in a loop.
- **Deduplication**: webhook delivery is at-least-once. The trigger remembers recently seen WhatsApp message IDs (24 hours, last 500) in workflow static data and ignores redeliveries.
- **Timestamps** are converted from Unix epoch seconds to ISO-8601 UTC.
- Events you didn't select are acknowledged with 200 but don't start the workflow.
- **Signature verification**: with a Webhook Secret on the credential, unsigned or wrongly signed requests get 401.

## Compatibility

Requires n8n 1.x or 2.x, tested on 2.x. Built and tested against the 360dialog Cloud API hosting (`waba-v2.360dialog.io`).

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [360dialog Messaging API documentation](https://docs.360dialog.com/docs/messaging-api)
