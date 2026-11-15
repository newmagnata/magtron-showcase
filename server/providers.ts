export type OutMessage =
  | { type: 'text'; text: string; delayMs?: number }
  | {
    type: 'media'; url: string; mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker'; caption?: string;
    /** Vídeo no formato "vídeo mensagem" (redondo). */ ptv?: boolean;
    /** Áudio enviado como mensagem de voz gravada (padrão). */ voice?: boolean;
    /** Tempo de "gravando/digitando" antes de enviar. */ delayMs?: number;
    /** Arquivo próprio já lido do banco: vai em base64, sem a Evolution precisar baixar nada. */
    inline?: { base64: string; mime: string; filename: string };
  }
  | { type: 'contact'; name: string; phone: string }
  | { type: 'template'; name: string; language: string; vars: string[]; fallback: string };

export type InboundMedia = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export type InboundEvent =
  | { kind: 'message'; externalId: string; phone: string; name?: string; text: string; media?: InboundMedia }
  | { kind: 'status'; status: 'connected' | 'disconnected' | 'connecting' };

export interface ConnectionInfo {
  id: string;
  config: Record<string, any>;
  apiKey?: string;
  webhookUrl: string;
}

export interface Provider {
  connect(c: ConnectionInfo): Promise<{ status: string; qr?: string }>;
  state(c: ConnectionInfo): Promise<string>;
  disconnect(c: ConnectionInfo): Promise<void>;
  send(c: ConnectionInfo, to: string, msg: OutMessage): Promise<{ externalId: string }>;
  parse(body: any): InboundEvent[];
  listContacts?(c: ConnectionInfo): Promise<{ phone: string; name?: string }[]>;
  call?(c: ConnectionInfo, to: string, seconds: number): Promise<void>;
  remove?(c: ConnectionInfo): Promise<void>;
  ownerPhone?(c: ConnectionInfo): Promise<string | undefined>;
}

async function http(url: string, init: RequestInit & { json?: unknown; extraMs?: number } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    signal: AbortSignal.timeout(30_000 + (init.extraMs ?? 0)), // "digitando/gravando" faz a Evolution esperar antes de responder
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* resposta não JSON */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  return data;
}

const sandbox: Provider = {
  connect: async () => ({ status: 'connected' }),
  state: async () => 'connected',
  disconnect: async () => {},
  send: async () => ({ externalId: `sandbox-${crypto.randomUUID()}` }),
  parse: (body) => [{
    kind: 'message',
    externalId: body.externalId ?? `sandbox-${crypto.randomUUID()}`,
    phone: String(body.phone), name: body.name, text: String(body.text ?? ''), media: body.media,
  }],
};

const evoBase = (c: ConnectionInfo) => String(c.config.baseUrl ?? process.env.EVOLUTION_URL ?? '').replace(/\/$/, '');
// Sem URL própria, a conexão usa a Evolution do servidor; a chave dela é sempre a do ambiente.
const evoHeaders = (c: ConnectionInfo) => ({
  // Evolution própria usa só a chave dela: a chave do servidor nunca sai para um endereço escolhido pelo usuário.
  apikey: (c.config.baseUrl ? c.apiKey : process.env.EVOLUTION_API_KEY ?? c.apiKey) ?? '',
});
const evoInstance = (c: ConnectionInfo) => `magtron_${c.id.replaceAll('-', '').slice(0, 16)}`;
const evoState = (s?: string) => (s === 'open' ? 'connected' : s === 'connecting' ? 'connecting' : 'disconnected');

/** Evolution API v2. Conecta por WhatsApp Web (QR code), canal não oficial. */
const evolution: Provider = {
  async connect(c) {
    const base = evoBase(c);
    if (!base) throw new Error('Informe a URL da Evolution API');
    const instance = evoInstance(c);
    const webhook = {
      enabled: true, url: c.webhookUrl, byEvents: false, base64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    };
    const existing = await http(`${base}/instance/connectionState/${instance}`, { headers: evoHeaders(c) }).catch(() => null);
    if (!existing) {
      await http(`${base}/instance/create`, {
        method: 'POST', headers: evoHeaders(c),
        json: { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true, webhook },
      });
    } else if (existing.instance?.state === 'open') {
      return { status: 'connected' };
    }
    const qr = await http(`${base}/instance/connect/${instance}`, { headers: evoHeaders(c) });
    return { status: 'connecting', qr: qr.base64 ?? qr.code };
  },
  async state(c) {
    const r = await http(`${evoBase(c)}/instance/connectionState/${evoInstance(c)}`, { headers: evoHeaders(c) });
    return evoState(r.instance?.state);
  },
  async disconnect(c) {
    await http(`${evoBase(c)}/instance/logout/${evoInstance(c)}`, { method: 'DELETE', headers: evoHeaders(c) });
  },
  async remove(c) {
    await http(`${evoBase(c)}/instance/delete/${evoInstance(c)}`, { method: 'DELETE', headers: evoHeaders(c) });
  },
  async ownerPhone(c) {
    const r = await http(`${evoBase(c)}/instance/fetchInstances?instanceName=${evoInstance(c)}`, { headers: evoHeaders(c) });
    const i = Array.isArray(r) ? r[0] : r;
    const raw = String(i?.ownerJid ?? i?.instance?.owner ?? i?.owner ?? '');
    const digits = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits.length >= 8 ? digits : undefined;
  },
  async listContacts(c) {
    const rows: any[] = await http(`${evoBase(c)}/chat/findContacts/${evoInstance(c)}`, { method: 'POST', headers: evoHeaders(c), json: { where: {} } });
    return rows.filter((r) => String(r.remoteJid ?? '').endsWith('@s.whatsapp.net'))
      .map((r) => ({ phone: String(r.remoteJid).split('@')[0], name: r.pushName ?? undefined }));
  },
  async call(c, to, seconds) {
    await http(`${evoBase(c)}/call/offer/${evoInstance(c)}`, { method: 'POST', headers: evoHeaders(c), json: { number: to, isVideo: false, callDuration: seconds } });
  },
  async send(c, to, msg) {
    if (msg.type === 'template') throw new Error('Template exige a API Oficial');
    const instance = evoInstance(c);
    const post = (path: string, json: any) => http(`${evoBase(c)}/message/${path}/${instance}`, { method: 'POST', headers: evoHeaders(c), json, extraMs: json.delay ?? 0 });
    let r: any;
    if (msg.type === 'text') {
      r = await post('sendText', { number: to, text: msg.text, ...(msg.delayMs ? { delay: msg.delayMs } : {}) });
    } else if (msg.type === 'contact') {
      r = await post('sendContact', { number: to, contact: [{ fullName: msg.name, wuid: msg.phone, phoneNumber: `+${msg.phone}` }] });
    } else {
      // A Evolution recusa endereços sem domínio (como http://magtron:3333), então arquivos próprios seguem em base64.
      const file = msg.inline?.base64 ?? msg.url;
      const delay = msg.delayMs ? { delay: msg.delayMs } : {};
      if (msg.mediaType === 'audio') r = await post('sendWhatsAppAudio', { number: to, audio: file, encoding: msg.voice !== false, ...delay });
      else if (msg.mediaType === 'sticker') r = await post('sendSticker', { number: to, sticker: file, ...delay });
      else if (msg.mediaType === 'video' && msg.ptv) r = await post('sendPtv', { number: to, video: file, ...delay });
      else {
        const fileName = msg.inline?.filename ?? decodeURIComponent(new URL(msg.url).pathname.split('/').pop() || 'arquivo');
        r = await post('sendMedia', {
          number: to, mediatype: msg.mediaType, media: file, caption: msg.caption ?? '', fileName,
          ...(msg.inline ? { mimetype: msg.inline.mime } : {}), ...delay,
        });
      }
    }
    return { externalId: r.key?.id ?? crypto.randomUUID() };
  },
  parse(body) {
    const event = String(body.event ?? '').toLowerCase().replaceAll('_', '.');
    if (event === 'connection.update') return [{ kind: 'status', status: evoState(body.data?.state) as any }];
    if (event !== 'messages.upsert') return [];
    const d = body.data;
    const raw: string = d?.key?.remoteJid ?? '';
    // Contas migradas para LID informam o número real em um campo alternativo.
    const jid: string = raw.endsWith('@lid') ? d?.key?.remoteJidAlt ?? d?.key?.senderPn ?? d?.senderPn ?? '' : raw;
    if (d?.key?.fromMe || !jid.endsWith('@s.whatsapp.net')) return [];
    const m = d.message ?? {};
    const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? '';
    const media: InboundMedia | undefined = m.imageMessage ? 'image' : m.videoMessage ? 'video' : m.audioMessage ? 'audio'
      : m.documentMessage || m.documentWithCaptionMessage ? 'document' : m.stickerMessage ? 'sticker' : undefined;
    return [{ kind: 'message', externalId: d.key.id, phone: jid.split('@')[0], name: d.pushName, text, media }];
  },
};

const META = 'https://graph.facebook.com/v23.0';

/** WhatsApp Business Cloud API (oficial). */
const meta: Provider = {
  async connect(c) {
    const r = await http(`${META}/${c.config.phoneNumberId}?fields=display_phone_number`, {
      headers: { authorization: `Bearer ${c.apiKey}` },
    });
    return { status: r.display_phone_number ? 'connected' : 'disconnected' };
  },
  state: async (c) => (await meta.connect(c)).status,
  disconnect: async () => {},
  async send(c, to, msg) {
    if (msg.type === 'contact') throw new Error('Contato exige a Evolution; a API Oficial não suporta aqui');
    const payload = msg.type === 'text'
      ? { type: 'text', text: { body: msg.text } }
      : msg.type === 'template'
      ? { type: 'template', template: { name: msg.name, language: { code: msg.language }, components: msg.vars.length ? [{ type: 'body', parameters: msg.vars.map((text) => ({ type: 'text', text })) }] : [] } }
      : { type: msg.mediaType, [msg.mediaType]: { link: msg.url, ...(msg.caption && msg.mediaType !== 'audio' ? { caption: msg.caption } : {}) } };
    const r = await http(`${META}/${c.config.phoneNumberId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${c.apiKey}` },
      json: { messaging_product: 'whatsapp', to, ...payload },
    });
    return { externalId: r.messages?.[0]?.id ?? crypto.randomUUID() };
  },
  parse(body) {
    const out: InboundEvent[] = [];
    for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((x: any) => x.wa_id === m.from)?.profile?.name;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? '';
        const media = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type) ? (m.type as InboundMedia) : undefined;
        out.push({ kind: 'message', externalId: m.id, phone: m.from, name, text, media });
      }
    }
    return out;
  },
};

export const providers: Record<string, Provider> = { sandbox, evolution, meta };
