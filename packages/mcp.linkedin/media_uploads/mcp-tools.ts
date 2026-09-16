// Entity: Media Uploads (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/media_uploads.md
// The upload-slot surface, one route: POST /api/media-uploads/request-upload
// (2026-09-16). Stateless: no table, no Domain. It reserves ONE object for an
// image or video and answers its public file_url plus two ways to fill it: a
// one-time upload_link on our domain (a person opens it and drops the file, or a
// shell runs curl -T) and, when file_type is given, a pre-signed S3 POST form.
// The file_url then goes to create_linkedin_post as images[].url / video.url.
// It exists because an agent that types a file out as base64 corrupts it, a
// picture pasted into a chat reaches the model as pixels rather than bytes, and
// neither upload path needs the OAuth token the agent's client holds.

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
  upload_link: z.string().describe('One-time link on our domain, valid until upload_expires_at. A person opens it in a browser and drops the file; a shell sends it with the curl line. Accepts one successful upload.'),
  upload: z.object({
    url: z.string().describe('The S3 form action to POST to.'),
    method: z.literal('POST'),
    enctype: z.literal('multipart/form-data'),
    fields: z.record(z.string()).describe('Send EVERY entry verbatim as a form field, before the file.'),
    file_field: z.literal('file').describe('The form field that carries the bytes; it must be the LAST part of the form.'),
  }).nullable().describe('A pre-signed S3 POST form for the same object, only when file_type was given; null otherwise.'),
  file_url: z.string().describe('The object\'s public https URL once uploaded: pass it as images[].url or video.url.'),
  upload_expires_at: z.string().describe('ISO 8601: the form refuses uploads after this.'),
  retained_until: z.string().describe('ISO 8601: the object is deleted after this.'),
  max_byte_size: z.number().int().describe('The largest file the form accepts, in bytes.'),
  curl: z.string().describe('A ready upload command through upload_link: replace <path> with the local file path. Answers 201 with the stored type and size.'),
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
      'Get a place for ONE image or video file, then pass its file_url to create_linkedin_post (images[].url or video.url) instead of base64. In a chat without HTTP (the user pasted or has the picture): give the user upload_link, ask them to open it and drop the file, and call create_linkedin_post with file_url once they confirm. With a shell: run the curl line (upload_link, replace <path>). Pass file_type to also get a pre-signed S3 POST form (upload). Never type base64 of a pasted image: the model sees pixels, not the file, and the bytes come out wrong. The link works once for 30 minutes, up to 35 MB, images PNG/JPEG/GIF/WEBP or video MP4/MOV/WEBM (checked by content). The file is public by URL and deleted after 7 days. 120 per workspace per hour.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/media-uploads/request-upload' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      file_name: z.string().min(1).max(200).optional()
        .describe('Optional file name, e.g. "q3-chart.png". Characters outside A-Z a-z 0-9 . _ - become "-" in the stored name. Omit when you do not know it yet.'),
      file_type: MediaUploadFileType.optional()
        .describe('Optional MIME type. Given, it also mints the pre-signed S3 form with this Content-Type bound in. The upload_link needs no type: it reads it from the file.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), RequestUploadResult),
    annotations: { title: 'Request media upload', ...HINTS },
  },
];
