// ======================================================
// index.js (VERSI FINAL STABIL)
// - Auto QR jika session tidak ada
// - Anti spam reconnect
// - SQLite storage
// - Prefix commands
// - Buttons
// ======================================================

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const P = require("pino");
const Database = require("better-sqlite3");

// ================== CONFIG ==================

const PREFIX = "!";
const OWNER_NUMBER = "081578859076";
const OWNER_JID = "6281578859076@s.whatsapp.net";

let isPublicMode = true;
let botNumberJid = null;

// ================== SQLITE ==================

const db = new Database("bot.db");
db.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_jid TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        msg_type TEXT NOT NULL,
        text_content TEXT NULL,
        mime_type TEXT NULL,
        file_name TEXT NULL,
        file_data BLOB NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

function saveMessageToDB({ sender, chatId, type, text, mimeType, fileName, fileBuffer }) {
    const stmt = db.prepare(`
        INSERT INTO wa_messages
        (sender_jid, chat_jid, msg_type, text_content, mime_type, file_name, file_data)
        VALUES (@sender, @chatId, @type, @text, @mimeType, @fileName, @fileData)
    `);

    stmt.run({
        sender,
        chatId,
        type,
        text: text || null,
        mimeType: mimeType || null,
        fileName: fileName || null,
        fileData: fileBuffer || null
    });
}

function listMessagesByChat(chatId, limit = 10) {
    return db.prepare(`
        SELECT id, msg_type, text_content, file_name, created_at
        FROM wa_messages
        WHERE chat_jid = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(chatId, limit);
}

function getMessageById(id) {
    return db.prepare(`
        SELECT * FROM wa_messages WHERE id = ?
    `).get(id);
}

// ================== START BOT ==================

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth-info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" })
    });

    // ================== CONNECTION HANDLER ==================
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📱 Scan QR berikut untuk login WhatsApp:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            botNumberJid = sock.user.id;
            console.log("✅ Bot berhasil terhubung!");
            console.log("🤖 Bot JID:", botNumberJid);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message;

            console.log("❌ Koneksi terputus!");
            console.log("⛔ Status Code:", code, "| Pesan:", msg);

            // Jika LOGGED OUT → hapus session manual
            if (code === DisconnectReason.loggedOut) {
                console.log("🚪 Kamu logged out dari WhatsApp!");
                console.log("➡ Hapus folder auth-info dan jalankan ulang: node index.js");
                return;
            }

            // Kalau bukan fatal error → reconnect
            console.log("🔁 Mencoba reconnect...");
            startBot();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // ================== MESSAGE HANDLER ==================
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (!from || from === "status@broadcast") return;
        if (msg.key.fromMe) return;

        // Ambil teks / button
        let rawText = "";
        let isButton = false;

        if (msg.message.buttonsResponseMessage) {
            const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
            if (buttonId.startsWith("ambil_")) {
                rawText = `${PREFIX}ambil ${buttonId.replace("ambil_", "")}`;
                isButton = true;
            }
        }

        if (!isButton) {
            rawText =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";
        }

        rawText = rawText.trim();
        if (!rawText.startsWith(PREFIX)) return;

        const cmd = rawText.slice(PREFIX.length).trim().toLowerCase();
        const sender = msg.key.participant || msg.key.remoteJid;

        const [command, ...args] = cmd.split(" ");
        const argText = args.join(" ");

        async function reply(text) {
            return sock.sendMessage(from, { text }, { quoted: msg });
        }

        console.log("📩 CMD:", command, "| Args:", argText);

        // ================== MODE SELF/PUBLIC ==================
        if (!isPublicMode && sender !== OWNER_JID) {
            return;
        }

        if (command === "self") {
            if (sender !== OWNER_JID) return reply("❌ Hanya owner.");
            isPublicMode = false;
            return reply("🔒 Mode SELF aktif.");
        }

        if (command === "public") {
            if (sender !== OWNER_JID) return reply("❌ Hanya owner.");
            isPublicMode = true;
            return reply("📢 Mode PUBLIC aktif.");
        }

        // ================== SAVE ==================
        if (command === "save" || command === "simpan") {
            try {
                let msgType = "text";
                let mimeType = null;
                let fileName = null;
                let fileBuffer = null;

                const content = msg.message;

                const mediaMsg =
                    content.imageMessage ||
                    content.documentMessage ||
                    content.videoMessage ||
                    content.audioMessage ||
                    null;

                if (mediaMsg) {
                    msgType = mediaMsg.mimetype.includes("image")
                        ? "image"
                        : mediaMsg.mimetype.includes("video")
                        ? "video"
                        : mediaMsg.mimetype.includes("audio")
                        ? "audio"
                        : "document";

                    mimeType = mediaMsg.mimetype;
                    fileName = mediaMsg.fileName;

                    fileBuffer = await downloadMediaMessage(msg, "buffer");
                }

                saveMessageToDB({
                    sender,
                    chatId: from,
                    type: msgType,
                    text: argText,
                    mimeType,
                    fileName,
                    fileBuffer
                });

                return reply("✅ Berhasil disimpan.");
            } catch (e) {
                console.error(e);
                return reply("❌ Error menyimpan.");
            }
        }

        // ================== LIST ==================
        if (command === "list") {
            const limit = parseInt(args[0] || "10");
            const rows = listMessagesByChat(from, limit);

            if (rows.length === 0) return reply("📭 Tidak ada data.");

            let txt = "📂 *Daftar Data*\n\n";
            for (let r of rows) {
                txt += `• ID: *${r.id}*\n  Tipe: ${r.msg_type}\n  File: ${r.file_name || "-"}\n  Waktu: ${r.created_at}\n\n`;
            }

            return sock.sendMessage(
                from,
                {
                    text: txt,
                    buttons: rows.slice(0, 3).map((r) => ({
                        buttonId: `ambil_${r.id}`,
                        buttonText: { displayText: `Ambil ${r.id}` },
                        type: 1
                    })),
                    headerType: 1
                },
                { quoted: msg }
            );
        }

        // ================== AMBIL ==================
        if (command === "ambil" || command === "get") {
            const id = parseInt(args[0]);
            const row = getMessageById(id);

            if (!row) return reply("❌ Tidak ditemukan.");

            if (row.msg_type === "text") {
                return reply(row.text_content || "(kosong)");
            }

            const fileBuffer = row.file_data;
            const caption = row.text_content || "";

            const options = { quoted: msg };

            if (row.msg_type === "image") {
                return sock.sendMessage(
                    from,
                    { image: fileBuffer, caption, mimetype: row.mime_type },
                    options
                );
            }
            if (row.msg_type === "video") {
                return sock.sendMessage(
                    from,
                    { video: fileBuffer, caption, mimetype: row.mime_type },
                    options
                );
            }
            if (row.msg_type === "audio") {
                return sock.sendMessage(
                    from,
                    { audio: fileBuffer, ptt: false, mimetype: row.mime_type },
                    options
                );
            }

            return sock.sendMessage(
                from,
                {
                    document: fileBuffer,
                    fileName: row.file_name || "file",
                    caption,
                    mimetype: row.mime_type
                },
                options
            );
        }

        // ================== MENU ==================
        if (command === "menu") {
            return reply(
                "📘 *MENU BOT*\n\n" +
                `Prefix: *${PREFIX}*\n` +
                `Mode: *${isPublicMode ? "PUBLIC" : "SELF"}*\n\n` +
                "• !menu\n" +
                "• !profil\n" +
                "• !save <teks>\n" +
                "• !list\n" +
                "• !ambil <id>\n" +
                "• !self / !public\n"
            );
        }

        if (command === "profil") {
            return reply(
                "🤖 *Profil Bot*\n" +
                "- Bot SQLite\n" +
                "- Fitur simpan & ambil file\n"
            );
        }

        return reply("❌ Command tidak dikenal.");
    });
}

// Jalankan bot
startBot().catch((err) => console.error("Fatal error:", err));
