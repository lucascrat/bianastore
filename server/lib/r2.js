// Cloudflare R2 access via the S3-compatible API. Every function here is a
// no-op-safe check first: if R2 env vars aren't configured yet, callers get a
// clean, typed error instead of a crash, so the rest of the API keeps working
// while R2 credentials are still pending.
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function isConfigured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

let client = null;
function getClient() {
  if (!isConfigured()) return null;
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

function publicUrlFor(key) {
  const base = process.env.R2_PUBLIC_URL_BASE || '';
  return `${base.replace(/\/$/, '')}/${key}`;
}

async function uploadBuffer({ buffer, key, contentType }) {
  const s3 = getClient();
  if (!s3) {
    const err = new Error('R2 not configured');
    err.code = 'R2_NOT_CONFIGURED';
    throw err;
  }
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return publicUrlFor(key);
}

async function deleteObject(key) {
  const s3 = getClient();
  if (!s3) {
    const err = new Error('R2 not configured');
    err.code = 'R2_NOT_CONFIGURED';
    throw err;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

module.exports = { isConfigured, uploadBuffer, deleteObject, publicUrlFor };
