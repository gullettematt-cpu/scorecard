// Photos in S3. The app uploads straight to S3 with short-lived signed URLs; picture messages are copied in.
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const photoKey = ({ workOrderId, serviceAppointmentId, kind, n, at = new Date() }) =>
  `vista/${workOrderId}/${serviceAppointmentId || 'job'}/${at.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${kind}-${n}.jpg`;

export function createPhotos({ bucket, region, s3 = new S3Client({ region }) }) {
  return {
    bucket,
    signPut: (key, contentType = 'image/jpeg') => getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 900 }),
    signGet: (key, expiresIn = 3600) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn }),
    put: (key, body, contentType = 'image/jpeg') => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })),
    head: key => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  };
}
