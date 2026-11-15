const timeout = () => AbortSignal.timeout(20_000);

async function json(res: Response, label: string) {
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* resposta não JSON */ }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${data?.error?.message ?? data?.message ?? ''}`.trim());
  return data;
}

export async function createPixCharge(token: string, c: { amount: number; description: string; email: string; idempotency: string; notifyUrl?: string }) {
  const res = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST', signal: timeout(),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-idempotency-key': c.idempotency },
    body: JSON.stringify({
      transaction_amount: c.amount, description: c.description, payment_method_id: 'pix', payer: { email: c.email },
      ...(c.notifyUrl?.startsWith('https://') ? { notification_url: c.notifyUrl } : {}),
    }),
  });
  const d = await json(res, 'Mercado Pago');
  return { id: String(d.id), code: d.point_of_interaction?.transaction_data?.qr_code as string };
}

export async function getPaymentStatus(token: string, id: string) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, signal: timeout() });
  return (await json(res, 'Mercado Pago')).status as string;
}

export async function metaInsights(token: string, adAccountId: string, days: number) {
  const id = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    level: 'campaign', fields: 'campaign_name,spend,impressions,clicks', limit: '200',
    time_range: JSON.stringify({ since, until }),
  });
  const res = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(id)}/insights?${params}`, { headers: { authorization: `Bearer ${token}` }, signal: timeout() });
  const rows: any[] = (await json(res, 'Meta Ads')).data ?? [];
  const campaigns = rows.map((r) => ({ name: r.campaign_name as string, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0 }));
  return { campaigns, spend: campaigns.reduce((a, c) => a + c.spend, 0) };
}

export async function syncMetaTemplates(token: string, wabaId: string) {
  const res = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/message_templates?limit=200`, { headers: { authorization: `Bearer ${token}` }, signal: timeout() });
  const rows: any[] = (await json(res, 'Meta')).data ?? [];
  return rows.map((t) => ({
    name: t.name as string, language: t.language as string, category: t.category as string, status: t.status as string,
    body: (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '',
  }));
}

export async function createMetaTemplate(token: string, wabaId: string, t: { name: string; language: string; category: string; body: string }) {
  const res = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/message_templates`, {
    method: 'POST', signal: timeout(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components: [{ type: 'BODY', text: t.body }] }),
  });
  return (await json(res, 'Meta')).status as string | undefined;
}

export async function textToSpeech(apiKey: string, voiceId: string, text: string): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
