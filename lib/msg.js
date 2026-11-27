const { proto, downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MEDIA_BYTES = Math.max(1024 * 1024, Number(process.env.MAX_MEDIA_DOWNLOAD_BYTES || 50 * 1024 * 1024));
const MEDIA_TIMEOUT_MS = Math.max(5000, Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || 60000));
const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mp3', 'ogg', 'm4a', 'wav', 'pdf', 'txt', 'bin']);
const MEDIA_KIND_MAP = {
	imageMessage: { kind: 'image', defaultExt: 'jpg' },
	videoMessage: { kind: 'video', defaultExt: 'mp4' },
	audioMessage: { kind: 'audio', defaultExt: 'mp3' },
	stickerMessage: { kind: 'sticker', defaultExt: 'webp' },
	documentMessage: { kind: 'document', defaultExt: 'bin' },
};

function sanitizeBaseName(name, fallback = 'media') {
	const base = path.basename(String(name || '')).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
	return base.slice(0, 80) || fallback;
}

function safeDocExt(rawFileName) {
	const base = path.basename(String(rawFileName || ''));
	const rawExt = path.extname(base).slice(1).toLowerCase()
		.replace('jpeg', 'jpg')
		.replace('png', 'jpg')
		.replace('m4a', 'mp3');
	return ALLOWED_EXTS.has(rawExt) ? rawExt : 'bin';
}

async function readStreamBounded(stream, maxBytes = MAX_MEDIA_BYTES, timeoutMs = MEDIA_TIMEOUT_MS) {
	const chunks = [];
	let total = 0;
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			try { stream.destroy?.(new Error('Media download timed out')); } catch { }
			reject(new Error('Media download timed out'));
		}, timeoutMs);
		timer.unref?.();
	});

	const consume = (async () => {
		for await (const chunk of stream) {
			total += chunk.length;
			if (total > maxBytes) {
				try { stream.destroy?.(new Error('Media exceeds size limit')); } catch { }
				throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, total);
	})();

	try {
		return await Promise.race([consume, timeoutPromise]);
	} finally {
		clearTimeout(timer);
		try { stream.destroy?.(); } catch { }
	}
}

const downloadMediaMessage = async (m, filename) => {
	if (!m || !m.type) throw new Error('No media message to download.');
	if (m.type === 'viewOnceMessage' || m.type === 'viewOnceMessageV2' || m.type === 'viewOnceMessageV2Extension') {
		throw new Error('View-once media is intentionally not downloadable.');
	}
	const spec = MEDIA_KIND_MAP[m.type];
	if (!spec) throw new Error(`Unsupported media type: ${m.type}`);

	const declaredSize = Number(m.msg?.fileLength || 0);
	if (declaredSize > MAX_MEDIA_BYTES) {
		throw new Error(`Media exceeds ${Math.round(MAX_MEDIA_BYTES / (1024 * 1024))} MB limit`);
	}

	const stream = await downloadContentFromMessage(m.msg, spec.kind);
	const buffer = await readStreamBounded(stream, MAX_MEDIA_BYTES, MEDIA_TIMEOUT_MS);

	if (filename) {
		const ext = m.type === 'documentMessage' ? safeDocExt(m.msg?.fileName) : spec.defaultExt;
		const safeName = `${sanitizeBaseName(filename, 'media')}.${ext}`;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danuwa-msg-'));
		const target = path.join(dir, safeName);
		try {
			fs.writeFileSync(target, buffer);
			return fs.readFileSync(target);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	return buffer;
};

const sms = (danuwa, m) => {
	if (m.key) {
		m.id = m.key.id
		m.chat = m.key.remoteJid
		m.fromMe = m.key.fromMe
		m.isGroup = m.chat.endsWith('@g.us')
		m.sender = m.fromMe ? danuwa.user.id.split(':')[0]+'@s.whatsapp.net' : m.isGroup ? m.key.participant : m.key.remoteJid
	}
	if (m.message) {
		m.type = getContentType(m.message)
		m.msg = (['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension'].includes(m.type)) ? m.message[m.type] : m.message[m.type]
		if (m.msg) {
			var quotedMention = m.msg.contextInfo != null ? m.msg.contextInfo.participant : ''
			var tagMention = m.msg.contextInfo != null ? m.msg.contextInfo.mentionedJid : []
			var mention = typeof(tagMention) == 'string' ? [tagMention] : tagMention
			mention != undefined ? mention.push(quotedMention) : []
			m.mentionUser = mention != undefined ? mention.filter(x => x) : []
			m.body = (m.type === 'conversation') ? m.msg : (m.type === 'extendedTextMessage') ? m.msg.text : (m.type == 'imageMessage') && m.msg.caption ? m.msg.caption : (m.type == 'videoMessage') && m.msg.caption ? m.msg.caption : (m.type == 'templateButtonReplyMessage') && m.msg.selectedId ? m.msg.selectedId : (m.type == 'buttonsResponseMessage') && m.msg.selectedButtonId ? m.msg.selectedButtonId : ''
			m.quoted = m.msg.contextInfo != undefined ? m.msg.contextInfo.quotedMessage : null
			if (m.quoted) {
				m.quoted.type = getContentType(m.quoted)
				m.quoted.id = m.msg.contextInfo.stanzaId
				m.quoted.sender = m.msg.contextInfo.participant
				m.quoted.fromMe = m.quoted.sender.split('@')[0].includes(danuwa.user.id.split(':')[0])
				m.quoted.msg = (['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension'].includes(m.quoted.type)) ? m.quoted[m.quoted.type] : m.quoted[m.quoted.type]
				var quoted_quotedMention = m.quoted.msg.contextInfo != null ? m.quoted.msg.contextInfo.participant : ''
				var quoted_tagMention = m.quoted.msg.contextInfo != null ? m.quoted.msg.contextInfo.mentionedJid : []
				var quoted_mention = typeof(quoted_tagMention) == 'string' ? [quoted_tagMention] : quoted_tagMention
				quoted_mention != undefined ? quoted_mention.push(quoted_quotedMention) : []
				m.quoted.mentionUser = quoted_mention != undefined ? quoted_mention.filter(x => x) : []
				m.quoted.fakeObj = proto.WebMessageInfo.fromObject({
					key: {
						remoteJid: m.chat,
						fromMe: m.quoted.fromMe,
						id: m.quoted.id,
						participant: m.quoted.sender
					},
					message: m.quoted
				})
				m.quoted.download = (filename) => downloadMediaMessage(m.quoted, filename)
				m.quoted.delete = () => danuwa.sendMessage(m.chat, { delete: m.quoted.fakeObj.key })
				m.quoted.react = (emoji) => danuwa.sendMessage(m.chat, { react: { text: emoji, key: m.quoted.fakeObj.key } })
			}
		}
		m.download = (filename) => downloadMediaMessage(m, filename)
	}
	
	m.reply = (teks, id = m.chat, option = { mentions: [m.sender] }) => danuwa.sendMessage(id, { text: teks, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyS = (stik, id = m.chat, option = { mentions: [m.sender] }) => danuwa.sendMessage(id, { sticker: stik, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyImg = (img, teks, id = m.chat, option = { mentions: [m.sender] }) => danuwa.sendMessage(id, { image: img, caption: teks, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyVid = (vid, teks, id = m.chat, option = { mentions: [m.sender], gif: false }) => danuwa.sendMessage(id, { video: vid, caption: teks, gifPlayback: option.gif, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyAud = (aud, id = m.chat, option = { mentions: [m.sender], ptt: false }) => danuwa.sendMessage(id, { audio: aud, ptt: option.ptt, mimetype: 'audio/mpeg', contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyDoc = (doc, id = m.chat, option = { mentions: [m.sender], filename: 'undefined.pdf', mimetype: 'application/pdf' }) => danuwa.sendMessage(id, { document: doc, mimetype: option.mimetype, fileName: option.filename, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyContact = (name, info, number) => {
		var vcard = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + 'FN:' + name + '\n' + 'ORG:' + info + ';\n' + 'TEL;type=CELL;type=VOICE;waid=' + number + ':+' + number + '\n' + 'END:VCARD'
		danuwa.sendMessage(m.chat, { contacts: { displayName: name, contacts: [{ vcard }] } }, { quoted: m })
	}
	m.react = (emoji) => danuwa.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
	
	return m
}

module.exports = { sms, downloadMediaMessage, sanitizeBaseName, safeDocExt, readStreamBounded }
