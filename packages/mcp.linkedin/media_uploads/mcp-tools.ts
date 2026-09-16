// Entity: Media Uploads (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/media_uploads.md
// The upload-slot surface, one route: POST /api/media-uploads/request-upload
// (2026-09-16). Stateless: no table, no Domain. It mints a pre-signed S3 POST
// form for ONE image or video and the public file_url the object will have; the
// caller uploads straight to the bucket and passes file_url to
// create_linkedin_post as images[].url / video.url. It exists because an agent
// that types a file out as base64 corrupts it, and a pre-signed form is the one
// upload path an agent can use without holding its client's OAuth token.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

const MediaUploadFileType = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

const RequestUploadResult = z.object({
  upload: z.object({
    url: z.string().describe('The S3 form action to POST to.'),
    method: z.literal('POST'),
    enctype: z.literal('multipart/form-data'),
    fields: z.record(z.string()).describe('Send EVERY entry verbatim as a form field, before the file.'),
    file_field: z.literal('file').describe('The form field that carries the bytes; it must be the LAST part of the form.'),
  }),
  file_url: z.string().describe('The object\'s public https URL once uploaded: pass it as images[].url or video.url.'),
  upload_expires_at: z.string().describe('ISO 8601: the form refuses uploads after this.'),
  retained_until: z.string().describe('ISO 8601: the object is deleted after this.'),
  max_byte_size: z.number().int().describe('The largest file the form accepts, in bytes.'),
  curl: z.string().describe('A ready upload command: replace <path> with the local file path. Prints 204 on success.'),
});

// Mints an upload capability; changes nothing on LinkedIn and nothing stored here.
const HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export const mediaUploadsTools: ToolDefinition[] = [
  {
    service: 'linkedin',
    entity: 'media_uploads',
    mount: 'linkedin.content',
    name: 'request_media_upload',
    description:
      'Get a place to upload ONE image or video, then pass its file_url to create_linkedin_post (images[].url or video.url) instead of base64. Answers a pre-signed S3 POST form (30 minutes, up to 35 MB, exactly the declared file_type) and the permanent public file_url. Upload with one multipart request: every upload.fields entry, then the file LAST in the field named file; the curl line in the response does it and prints 204. The file never passes through this API, is public by URL and is deleted after 7 days. Use it whenever you can run an HTTP request (a shell, code, a workflow tool): typing base64 by hand corrupts files. Limit 120 per workspace per hour.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/media-uploads/request-upload' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      file_name: z.string().min(1).max(200)
        .describe('The file name, e.g. "q3-chart.png". Characters outside A-Z a-z 0-9 . _ - become "-" in the stored name.'),
      file_type: MediaUploadFileType
        .describe('The file\'s MIME type. Bound into the form: S3 refuses an upload of any other Content-Type.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), RequestUploadResult),
    annotations: { title: 'Request media upload', ...HINTS },
  },
];
