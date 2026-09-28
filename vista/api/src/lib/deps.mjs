// Real dependencies in AWS. Secrets come from SSM Parameter Store (SecureString) under SECRETS_PATH,
// loaded once per Lambda container. Nothing secret is in the code, the template or environment variables.
import { createSalesforce } from './salesforce.mjs';
import { dynamoStore } from './store.mjs';
import { createPeople } from './people.mjs';
import { createPhotos } from './photos.mjs';
import { createTwilio } from './twilio.mjs';
import { createVi, createTranslations } from './vi.mjs';

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

async function loadSecrets(path, region) {
  const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region }); const out = {}; let NextToken;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken }));
    for (const p of r.Parameters) out[p.Name.slice(path.length).replace(/^\//, '')] = p.Value;
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

let cached;
export async function realDeps(env = process.env) {
  if (cached) return cached;
  const region = env.AWS_REGION;
  const secrets = await loadSecrets(env.SECRETS_PATH, region);
  const need = k => { if (!secrets[k]) throw new Error(`missing secret ${env.SECRETS_PATH}/${k}`); return secrets[k]; };
  const store = await dynamoStore({ table: env.TABLE, region });
  const sf = createSalesforce({ loginUrl: env.SF_LOGIN_URL, clientId: env.SF_CLIENT_ID, username: env.SF_USERNAME, privateKey: need('SF_PRIVATE_KEY') });
  const twilio = createTwilio({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: need('TWILIO_AUTH_TOKEN'), from: env.TWILIO_FROM });
  const vi = createVi({ apiKey: need('ANTHROPIC_API_KEY') });
  cached = {
    sf, store, twilio, vi,
    people: createPeople({ store, sf }),
    photos: createPhotos({ bucket: env.PHOTOS_BUCKET, region }),
    translations: createTranslations({ store, vi }),
    secrets: { jwt: need('APP_JWT_SECRET'), admin: need('ADMIN_TOKEN'), twilioAuthToken: need('TWILIO_AUTH_TOKEN') },
    config: { appUrl: env.APP_URL, publicApiUrl: env.PUBLIC_API_URL, alertPhones: list(env.ALERT_PHONES), adminPhones: list(env.ADMIN_PHONES), workerFunction: env.WORKER_FUNCTION }
  };
  return cached;
}
