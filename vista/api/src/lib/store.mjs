// Vista's own small data (never Salesforce): people and their preferences, sign-in codes, text
// conversations, the translation cache, language requests, progress photos, notice de-duplication.
// One DynamoDB table, keys pk/sk, optional `ttl` (epoch seconds).

export function memoryStore() {
  const m = new Map();
  const k = (pk, sk) => `${pk}\u0000${sk}`;
  return {
    async get(pk, sk) { const v = m.get(k(pk, sk)); return v && (!v.ttl || v.ttl > Date.now() / 1000) ? structuredClone(v) : null; },
    async put(item) { m.set(k(item.pk, item.sk), structuredClone(item)); },
    async del(pk, sk) { m.delete(k(pk, sk)); },
    async query(pk, skPrefix = '') { return [...m.values()].filter(v => v.pk === pk && v.sk.startsWith(skPrefix)).map(v => structuredClone(v)); },
    async putIfAbsent(item) { if (m.has(k(item.pk, item.sk)) && (await this.get(item.pk, item.sk))) return false; await this.put(item); return true; }
  };
}

export async function dynamoStore({ table, region }) {
  const { DynamoDBClient, ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  return {
    async get(pk, sk) { return (await doc.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item || null; },
    async put(item) { await doc.send(new PutCommand({ TableName: table, Item: item })); },
    async del(pk, sk) { await doc.send(new DeleteCommand({ TableName: table, Key: { pk, sk } })); },
    async query(pk, skPrefix = '') {
      const out = []; let start;
      do {
        const r = await doc.send(new QueryCommand({ TableName: table, KeyConditionExpression: skPrefix ? 'pk = :p AND begins_with(sk, :s)' : 'pk = :p',
          ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk }, ExclusiveStartKey: start }));
        out.push(...r.Items); start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async putIfAbsent(item) {
      try { await doc.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' })); return true; }
      catch (e) { if (e instanceof ConditionalCheckFailedException || e.name === 'ConditionalCheckFailedException') return false; throw e; }
    }
  };
}
