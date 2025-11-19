// ======================================================
// index.js (FINAL + BUTTON LIST)
// Bot WhatsApp dengan:
// - Prefix (!) → hanya respon kalau pakai prefix
// - Owner mode (self/public)
// - SQLite (bot.db) untuk simpan text + file
// - Fitur:
//     !save / !simpan      -> simpan text/file ke DB
//     !list [n]            -> list data tersimpan di chat itu + tombol
//     !ambil <id>          -> kirim ulang file/text dari DB
//     !self / !public      -> ubah mode bot
// ======================================================

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const P = require("pino");
const Database = require("better-sqlite3");

// ================== CONFIG ==================

const PREFIX = "!";

// Nomor owner dalam format biasa (Indonesia)
const OWNER_NUMBER = "081578859076";
// Konversi ke format internasional (628...) lalu jadikan JID
const OWNER_JID = "6281578859076@s.whatsapp.net";

// Mode bot: true = PUBLIC, false = SELF
let isPublicMode = true;

// JID nomor bot sendiri (akan diisi setelah konek)
let botNumberJid = null;

// ================== SQLITE CONNECTION ==================

const db = new Database("bot.db");

// Buat tabel kalau belum ada
db.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_jid TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        msg_type TEXT NOT NULL,              -- text, image, document, video, audio, other
        text_content TEXT NULL,
        mime_type TEXT NULL,
        file_name TEXT NULL,
        file_data BLOB NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Helper simpan ke DB
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

// Helper ambil list data per chat
function listMessagesByChat(chatId, limit = 10) {
    const stmt = db.prepare(`
        SELECT id, msg_type, text_content, file_name, created_at
        FROM wa_messages
        WHERE chat_jid = ?
        ORDER BY id DESC
        LIMIT ?
    `);
    return stmt.all(chatId, limit);
}

// Helper ambil satu row by id
function getMessageById(id) {
    const stmt = db.prepare(`
        SELECT id, sender_jid, chat_jid, msg_type,
               text_content, mime_type, file_name, file_data, created_at
        FROM wa_messages
        WHERE id = ?
    `);
    return stmt.get(id);
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

    // --- Connection handler ---
    sock.ev.on("connection.update", (update) => {
        const { connection, qr } = update;

        if (qr) {
            console.log("QR Code muncul, scan pakai WhatsApp di HP kamu:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            botNumberJid = sock.user?.id || null;
            console.log("✅ Bot WhatsApp sudah terhubung!");
            console.log("🤖 JID Bot :", botNumberJid);
            console.log("👑 Owner  :", OWNER_JID);
            console.log("📢 Mode   :", isPublicMode ? "PUBLIC" : "SELF");
        } else if (connection === "close") {
            console.log("❌ Koneksi terputus, mencoba menghubungkan ulang...");
            startBot();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // --- Message handler ---
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const from = msg.key.remoteJid;
        if (!from || from === "status@broadcast") return;
        if (msg.key.fromMe) return; // abaikan pesan dari bot sendiri

        const isGroup = from.endsWith("@g.us");
        const senderJid = isGroup ? (msg.key.participant || from) : from;

        // ========== BACA PESAN / BUTTON ==========

        let rawText = "";
        let simulatedFromButton = false;

        // Jika user menekan tombol quick reply
        if (msg.message.buttonsResponseMessage) {
            const btn = msg.message.buttonsResponseMessage;
            const buttonId = btn.selectedButtonId || "";
            console.log("🔘 Button pressed:", buttonId);

            // Contoh buttonId: "ambil_12"
            if (buttonId.startsWith("ambil_")) {
                const idPart = buttonId.slice("ambil_".length);
                rawText = `${PREFIX}ambil ${idPart}`; // simulasi command teks
                simulatedFromButton = true;
            } else if (buttonId === "menu") {
                rawText = `${PREFIX}menu`;
                simulatedFromButton = true;
            } else {
                // tombol lain kalau mau ditambah
                rawText = "";
            }
        }

        // Kalau bukan dari button, baca teks/caption biasa
        if (!simulatedFromButton) {
            if (msg.message.conversation) {
                rawText = msg.message.conversation;
            } else if (msg.message.extendedTextMessage) {
                rawText = msg.message.extendedTextMessage.text || "";
            } else if (msg.message.imageMessage && msg.message.imageMessage.caption) {
                rawText = msg.message.imageMessage.caption;
            } else if (msg.message.documentMessage && msg.message.documentMessage.caption) {
                rawText = msg.message.documentMessage.caption;
            } else if (msg.message.videoMessage && msg.message.videoMessage.caption) {
                rawText = msg.message.videoMessage.caption;
            }
        }

        rawText = (rawText || "").trim();
        if (!rawText) return;

        // ✅ Wajib prefix (kecuali sudah disimulasikan dari button di atas)
        if (!rawText.startsWith(PREFIX)) {
            return;
        }

        const cmdText = rawText.slice(PREFIX.length).trim();
        const lowerCmdText = cmdText.toLowerCase();

        console.log("📩 Dari:", senderJid, "| Chat:", from, "| Raw:", rawText, "| CMD:", cmdText);

        // ================== MODE SELF/PUBLIC FILTER ==================
        if (!isPublicMode) {
            const allowedJids = [OWNER_JID];
            if (botNumberJid) {
                allowedJids.push(botNumberJid);
            }

            if (!allowedJids.includes(senderJid)) {
                console.log("⛔ Pesan ditolak (SELF mode, bukan owner/bot).");
                return;
            }
        }

        async function reply(text) {
            await sock.sendMessage(from, { text }, { quoted: msg });
        }

        // Pisah command & argumen
        const [commandRaw, ...args] = lowerCmdText.split(/\s+/);
        const command = commandRaw || "";
        const argText = args.join(" ");

        // ================== COMMAND OWNER: MODE ==================

        if (command === "self" || lowerCmdText === "mode self") {
            if (senderJid !== OWNER_JID) {
                await reply("❌ Hanya owner yang boleh mengubah mode bot.");
                return;
            }
            isPublicMode = false;
            await reply("🔒 *Mode SELF aktif.*\nSekarang hanya owner (dan bot) yang bisa memakai fitur.");
            console.log("🔒 Mode diubah ke SELF oleh owner.");
            return;
        }

        if (command === "public" || lowerCmdText === "mode public") {
            if (senderJid !== OWNER_JID) {
                await reply("❌ Hanya owner yang boleh mengubah mode bot.");
                return;
            }
            isPublicMode = true;
            await reply("📢 *Mode PUBLIC aktif.*\nSekarang semua nomor bisa memakai fitur bot.");
            console.log("📢 Mode diubah ke PUBLIC oleh owner.");
            return;
        }

        // ================== FITUR SIMPAN KE SQLITE ==================

        if (command === "save" || command === "simpan") {
            try {
                let msgType = "text";
                let mimeType = null;
                let fileName = null;
                let fileBuffer = null;
                let textToSave = argText || null;

                const content = msg.message;

                const mediaMsg =
                    content.imageMessage ||
                    content.documentMessage ||
                    content.videoMessage ||
                    content.audioMessage ||
                    null;

                if (mediaMsg) {
                    if (content.imageMessage) msgType = "image";
                    else if (content.documentMessage) msgType = "document";
                    else if (content.videoMessage) msgType = "video";
                    else if (content.audioMessage) msgType = "audio";
                    else msgType = "other";

                    mimeType = mediaMsg.mimetype || null;
                    fileName = mediaMsg.fileName || null;

                    fileBuffer = await downloadMediaMessage(
                        msg,
                        "buffer",
                        {},
                        { logger: sock.logger }
                    );

                    if (!textToSave) {
                        const cap = mediaMsg.caption || "";
                        textToSave = cap.replace(new RegExp("^" + PREFIX, "i"), "").trim() || null;
                    }
                }

                saveMessageToDB({
                    sender: senderJid,
                    chatId: from,
                    type: msgType,
                    text: textToSave,
                    mimeType,
                    fileName,
                    fileBuffer
                });

                await reply("✅ Data berhasil disimpan ke database (SQLite).");
                console.log("💾 Tersimpan ke DB (SQLite):", {
                    sender: senderJid,
                    chat: from,
                    type: msgType,
                    text: textToSave
                });
            } catch (err) {
                console.error("❌ Gagal menyimpan ke DB (SQLite):", err);
                await reply("❌ Terjadi error saat menyimpan ke database (SQLite).");
            }
            return;
        }

        // ================== FITUR LIST FILE/TEXT YANG TERSIMPAN ==================
        //
        // Cara pakai:
        //   !list
        //   !list 5   (optional jumlah)
        //
        // Menampilkan data yang TERSIMPAN untuk chat itu saja + tombol ambil (max 3).

        if (command === "list" || command === "listfile" || command === "listfiles") {
            let limit = 10;
            if (args[0] && !isNaN(parseInt(args[0], 10))) {
                limit = Math.max(1, Math.min(50, parseInt(args[0], 10)));
            }

            const rows = listMessagesByChat(from, limit);
            if (!rows || rows.length === 0) {
                await reply("📭 Belum ada data tersimpan untuk chat ini.");
                return;
            }

            let text = "📂 *Daftar Data Tersimpan (Terbaru)*\n\n";
            for (const r of rows) {
                const previewText = (r.text_content || "").slice(0, 40).replace(/\s+/g, " ");
                text += `• ID: *${r.id}*\n  Tipe: *${r.msg_type}*`;
                if (r.file_name) {
                    text += `\n  File: ${r.file_name}`;
                }
                if (previewText) {
                    text += `\n  Teks: ${previewText}${r.text_content && r.text_content.length > 40 ? "..." : ""}`;
                }
                text += `\n  Waktu: ${r.created_at}\n\n`;
            }

            text += `Kamu bisa:\n- Ketik: *${PREFIX}ambil <id>*\n- Atau tekan tombol cepat di bawah (maks 3 data terbaru).`;

            // Buat tombol dari 3 data terbaru
            const topRows = rows.slice(0, 3);
            const buttons = topRows.map((r) => ({
                buttonId: `ambil_${r.id}`, // akan diproses di buttonsResponseMessage
                buttonText: {
                    displayText: `Ambil ID ${r.id} (${r.msg_type})`
                },
                type: 1
            }));

            await sock.sendMessage(
                from,
                {
                    text,
                    buttons,
                    headerType: 1
                },
                { quoted: msg }
            );

            return;
        }

        // ================== FITUR AMBIL FILE/TEXT DARI DB ==================
        //
        // Cara pakai:
        //   !ambil 10
        //   !get 10
        //
        // Mengirim ulang text/file berdasarkan ID.
        // Juga dipanggil otomatis saat user pencet tombol (buttonId: ambil_<id>).

        if (command === "ambil" || command === "get") {
            if (!args[0] || isNaN(parseInt(args[0], 10))) {
                await reply(`❌ Format salah.\nContoh: *${PREFIX}ambil 10*`);
                return;
            }

            const id = parseInt(args[0], 10);
            const row = getMessageById(id);

            if (!row) {
                await reply(`❌ Data dengan ID *${id}* tidak ditemukan.`);
                return;
            }

            // Pastikan hanya bisa ambil data dari chat yang sama (lebih aman)
            if (row.chat_jid !== from) {
                await reply("⛔ Kamu tidak boleh mengambil data dari chat lain.");
                return;
            }

            try {
                if (row.msg_type === "text" || !row.file_data) {
                    const textMsg = row.text_content || "(tidak ada teks)";
                    await reply(`📝 *Data ID ${row.id}*\n\n${textMsg}`);
                } else {
                    const caption = row.text_content || `File dari ID ${row.id}`;
                    const fileBuffer = row.file_data; // Buffer dari SQLite
                    const mimeType = row.mime_type || undefined;
                    const options = { quoted: msg };

                    if (row.msg_type === "image") {
                        await sock.sendMessage(
                            from,
                            { image: fileBuffer, mimetype: mimeType, caption },
                            options
                        );
                    } else if (row.msg_type === "document") {
                        await sock.sendMessage(
                            from,
                            {
                                document: fileBuffer,
                                mimetype: mimeType,
                                fileName: row.file_name || `file-${row.id}`,
                                caption
                            },
                            options
                        );
                    } else if (row.msg_type === "video") {
                        await sock.sendMessage(
                            from,
                            { video: fileBuffer, mimetype: mimeType, caption },
                            options
                        );
                    } else if (row.msg_type === "audio") {
                        await sock.sendMessage(
                            from,
                            { audio: fileBuffer, mimetype: mimeType, ptt: false },
                            options
                        );
                    } else {
                        // fallback kirim sebagai dokumen
                        await sock.sendMessage(
                            from,
                            {
                                document: fileBuffer,
                                mimetype: mimeType,
                                fileName: row.file_name || `file-${row.id}`,
                                caption
                            },
                            options
                        );
                    }
                }

                console.log("📤 Berhasil kirim ulang data ID:", row.id);
            } catch (err) {
                console.error("❌ Error saat mengirim ulang data ID", id, ":", err);
                await reply("❌ Terjadi error saat mengirim ulang file/teks dari database.");
            }

            return;
        }

        // ================== COMMAND UMUM ==================

        if (command === "menu" || command === "start") {
            const menuText =
                "👋 *Halo, selamat datang di Bot WhatsApp!*\n\n" +
                `Prefix saat ini: *${PREFIX}*\n` +
                `Mode: *${isPublicMode ? "PUBLIC (semua bisa pakai)" : "SELF (hanya owner)"}*\n\n` +
                "📚 *Daftar Perintah Umum:*\n" +
                `- ${PREFIX}menu → Tampilkan menu ini\n` +
                `- ${PREFIX}profil → Info singkat bot\n` +
                `- ${PREFIX}help → Bantuan perintah\n` +
                `- ${PREFIX}jam → Menampilkan jam sekarang (WIB)\n` +
                `- ${PREFIX}save <teks> → Simpan teks ke database\n` +
                `- kirim gambar/file dengan caption: ${PREFIX}save ... → simpan file + teks\n` +
                `- ${PREFIX}list → Lihat data tersimpan di chat ini (dengan tombol)\n` +
                `- ${PREFIX}ambil <id> → Ambil ulang file/teks dari database\n\n` +
                "⚙ *Perintah Owner:*\n" +
                `- ${PREFIX}self → Ubah bot ke mode SELF\n` +
                `- ${PREFIX}public → Ubah bot ke mode PUBLIC\n`;

            await reply(menuText);
            return;
        }

        if (command === "profil") {
            const profilText =
                "📄 *Profil Bot*\n" +
                "- Nama: Bot WhatsApp Cindy\n" +
                "- Versi: 1.0.0 (SQLite + Buttons)\n" +
                `- Prefix: ${PREFIX}\n` +
                `- Mode: ${isPublicMode ? "PUBLIC" : "SELF"}\n` +
                `- Owner: wa.me/${OWNER_JID.replace("@s.whatsapp.net", "")}\n\n` +
                `Coba ketik *${PREFIX}menu* untuk melihat perintah lain.`;

            await reply(profilText);
            return;
        }

        if (command === "help" || command === "bantuan") {
            const helpText =
                "🛟 *Bantuan Perintah*\n\n" +
                `Semua perintah harus diawali prefix: *${PREFIX}*\n\n` +
                "Contoh:\n" +
                `- ${PREFIX}menu\n` +
                `- ${PREFIX}profil\n` +
                `- ${PREFIX}jam\n` +
                `- ${PREFIX}save contoh teks\n` +
                `- ${PREFIX}list\n` +
                `- ${PREFIX}ambil 10\n\n` +
                "Perintah owner:\n" +
                `- ${PREFIX}self\n` +
                `- ${PREFIX}public\n`;

            await reply(helpText);
            return;
        }

        if (command === "jam") {
            const now = new Date();
            const formatter = new Intl.DateTimeFormat("id-ID", {
                timeZone: "Asia/Jakarta",
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            });
            const waktu = formatter.format(now);

            const jamText =
                "🕒 *Jam Sekarang (WIB)*\n" +
                waktu + "\n\n" +
                `Ketik *${PREFIX}menu* untuk lihat perintah lain.`;

            await reply(jamText);
            return;
        }

        // ================== DEFAULT: COMMAND TIDAK DIKENAL ==================
        await reply(
            `Saya tidak mengenali perintah: *${cmdText}* 😅\n\n` +
            `Ketik *${PREFIX}menu* untuk melihat daftar perintah yang tersedia.`
        );
    });
}

startBot().catch((err) => {
    console.error("Terjadi error di bot:", err);
});
