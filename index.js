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
const CloudConvert = require("cloudconvert");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

// =============================================================
// ==============  API KEY (ISI SENDIRI NANTI!)  ===============
// =============================================================
const CLOUDCONVERT_API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiZGNiMjBiYzFmNjUwZTY5MjZmYjRkY2I4NDJmYzY4ZjZiMTZlOTk4NzZhMjNjY2Q3OGNjZTZiZmNjZWVkYTVkZWFmMjM1YWQ4NDhkMmY4ZTAiLCJpYXQiOjE3NjM2NDM3NTguMTMyOTg1LCJuYmYiOjE3NjM2NDM3NTguMTMyOTg2LCJleHAiOjQ5MTkzMTczNTguMTI1ODMyLCJzdWIiOiI3MzUyNDc3OSIsInNjb3BlcyI6WyJ1c2VyLnJlYWQiLCJ1c2VyLndyaXRlIiwidGFzay5yZWFkIiwidGFzay53cml0ZSIsIndlYmhvb2sucmVhZCIsIndlYmhvb2sud3JpdGUiLCJwcmVzZXQucmVhZCIsInByZXNldC53cml0ZSJdfQ.mm1xInqF2WeQkLj_6kAk_KiLe0a7YH6jW0Wm4huHh4RH6EddRVApRAPcoa2H-afBFBob3jJmG6FMY-aPZTt83527jGcG7Xx2X8vuRXU630fbRvUcSa3wyfnejVw2G7YikG7W3aoyZEmTok-sCb-F1P7SGLweI3m72cEO2LHthd8lV7wWmcE-det08FhFfmPojzrgAINHmUpWOqIzfpOb7ye0B9AK3zWZP1p5qPbwGXiYL0kdXGv0gHn2kLMYgwN92LlbtPLbFfvKg8llcUWpq7RrybAD2Qb-0E-dKdeuCX4wVqC1Javztp9NQD7tGP0-Zf1QtSEqEHUi32IQgqlamAlOuFgsgub-9_R6zSI3PitRBZNgRFaDacy_z-o6OuNZboaEqIjLE7wuVeskMGNjm_mnCngztD6Ia5xUTZRbPnyWPmNW9NL_slMcrGNAQWWxs27pfuRxzWXAZ3prRHdhSkoxMXW_vO6Fi31KMHVBWujbkQSjlDTznDrdx_mRIrhdnQnn4EmLRCMSsUVZI8pj4wyEPzyzCFt-j7qBfXTmHljkSSyTGrYV0nc08UdCDA2b1RTHz3UiAC-KOhqEl48xNhnP0VOXccnpHjAzdLOi83hDQBqEPQZrXIqcufD6cRLkk7bsYElLqb-ezevEiG2SuPchR2g2F_nWHH4D4e52Lo8";
const REMOVE_BG_API_KEY = "QDGnRLDXXPqc9iXDUFCVUXic";

// =============================================================
// ===============  CONFIG BOT  ================================
// =============================================================
const PREFIX = "!";
const OWNER_JID = "6281578859076@s.whatsapp.net";

let isPublicMode = true;
let botNumberJid = null;

// =============================================================
// ===============  DATABASE SQLITE ============================
// =============================================================
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

    const info = stmt.run({
        sender,
        chatId,
        type,
        text: text || null,
        mimeType: mimeType || null,
        fileName: fileName || null,
        fileData: fileBuffer || null
    });

    return info.lastInsertRowid;
}

function listMessagesByChat(chatId, limit = 20) {
    return db.prepare(`
        SELECT id, msg_type, text_content, file_name, created_at
        FROM wa_messages
        WHERE chat_jid = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(chatId, limit);
}

function getMessageById(id) {
    return db.prepare(`SELECT * FROM wa_messages WHERE id = ?`).get(id);
}

function deleteMessageById(id, chatId) {
    return db.prepare(`
        DELETE FROM wa_messages
        WHERE id = ? AND chat_jid = ?
    `).run(id, chatId);
}

function deleteAllMessagesByChat(chatId) {
    return db.prepare(`
        DELETE FROM wa_messages
        WHERE chat_jid = ?
    `).run(chatId);
}

// =============================================================
// ===============  FILE STORAGE TEMP DIR ======================
// =============================================================
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ========== Helper PDF Range Parsing ==========
function parsePageRanges(rangeStr, maxPages) {
    const ranges = rangeStr.split(",");
    const pages = new Set();
    for (const r of ranges) {
        const p = r.trim();
        if (!p) continue;
        if (p.includes("-")) {
            const [s, e] = p.split("-");
            let start = parseInt(s);
            let end = parseInt(e);
            if (start < 1) start = 1;
            if (end > maxPages) end = maxPages;
            for (let i = start; i <= end; i++) pages.add(i);
        } else {
            const num = parseInt(p);
            if (num >= 1 && num <= maxPages) pages.add(num);
        }
    }
    return Array.from(pages);
}

// =============================================================
// ===============  IMAGE FUNCTIONS (sharp) =====================
// =============================================================

// compress image
async function compressImageBuffer(imgBuffer) {
    return await sharp(imgBuffer).jpeg({ quality: 60 }).toBuffer();
}

// enhance image (HD)
async function enhanceImageBuffer(imgBuffer) {
    const img = sharp(imgBuffer);
    const metadata = await img.metadata();
    const width = metadata.width || 800;
    const newWidth = Math.round(width * 1.5);
    return await img.resize({ width: newWidth }).sharpen().jpeg({ quality: 90 }).toBuffer();
}

// remove background via remove.bg
async function removeBackground(imgBuffer) {
    const formData = new FormData();
    formData.append("image_file", imgBuffer, "image.jpg");
    formData.append("size", "auto");

    const res = await fetch("https://api.remove.bg/v1.0/removebg", {
        method: "POST",
        headers: { "X-Api-Key": REMOVE_BG_API_KEY },
        body: formData
    });

    if (!res.ok) throw new Error("RemoveBG gagal: " + await res.text());
    return Buffer.from(await res.arrayBuffer());
}

// =============================================================
// ===============  PDF FUNCTIONS ===============================
// =============================================================

// JPG → PDF
async function imageToPdf(imgBuf) {
    const pdfDoc = await PDFDocument.create();
    let img;
    try { img = await pdfDoc.embedJpg(imgBuf); }
    catch { img = await pdfDoc.embedPng(imgBuf); }

    const page = pdfDoc.addPage();
    const { width, height } = img;
    const scale = Math.min(page.getWidth() / width, page.getHeight() / height);

    page.drawImage(img, {
        x: (page.getWidth() - width * scale) / 2,
        y: (page.getHeight() - height * scale) / 2,
        width: width * scale,
        height: height * scale
    });

    return Buffer.from(await pdfDoc.save());
}

// compress PDF (simple)
async function compressPDF(pdfBuf) {
    const pdfDoc = await PDFDocument.load(pdfBuf);
    const out = await pdfDoc.save({ useObjectStreams: true });
    return Buffer.from(out);
}

// merge PDF array
async function mergePDFs(buffers) {
    const merged = await PDFDocument.create();
    for (const buf of buffers) {
        const pdf = await PDFDocument.load(buf);
        const pages = await merged.copyPages(pdf, pdf.getPageIndices());
        pages.forEach(p => merged.addPage(p));
    }
    return Buffer.from(await merged.save());
}

// split PDF
async function splitPDF(pdfBuf, rangeStr) {
    const pdf = await PDFDocument.load(pdfBuf);
    const max = pdf.getPageCount();
    const pages = parsePageRanges(rangeStr, max);
    const newPDF = await PDFDocument.create();
    const cp = await newPDF.copyPages(pdf, pages.map(i => i - 1));
    cp.forEach(p => newPDF.addPage(p));
    return Buffer.from(await newPDF.save());
}

// =============================================================
// ===============  CLOUDCONVERT SIMPLE MODE ====================
// =============================================================
const cloudConvertClient = new CloudConvert(CLOUDCONVERT_API_KEY, false);

async function convertCloudConvert(buffer, fromExt, toExt) {
    const job = await cloudConvertClient.jobs.create({
        tasks: {
            "import-my-file": {
                operation: "import/base64",
                file: buffer.toString("base64"),
                filename: `input.${fromExt}`
            },
            "convert-my-file": {
                operation: "convert",
                input: "import-my-file",
                output_format: toExt
            },
            "export-my-file": {
                operation: "export/url",
                input: "convert-my-file"
            }
        }
    });

    const exportTask = job.tasks.filter(t => t.name === "export-my-file")[0];
    const file = exportTask.result.files[0];

    const res = await fetch(file.url);
    return Buffer.from(await res.arrayBuffer());
}

// =============================================================
// ===============  WHATSAPP BOT START ==========================
// =============================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth-info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" })
    });

    sock.ev.on("connection.update", update => {
        const { connection, qr } = update;

        if (qr) {
            console.log("SCAN QR:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            botNumberJid = sock.user.id;
            console.log("BOT CONNECTED AS:", botNumberJid);
        }

        if (connection === "close") {
            console.log("RECONNECTING...");
            startBot();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // =============================================================
    // =============== MESSAGE HANDLER ==============================
    // =============================================================
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (!from || msg.key.fromMe) return;

        const sender = msg.key.participant || from;

        // get text
        let rawText =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            "";

        rawText = rawText.trim();
        if (!rawText.startsWith(PREFIX)) return;

        const cmd = rawText.slice(1).trim().toLowerCase();       
        const [command, ...args] = cmd.split(" ");
        const argText = args.join(" ").trim();

        const reply = text => sock.sendMessage(from, { text }, { quoted: msg });

        // ================= MODE =================
        if (command === "self" && sender === OWNER_JID) {
            isPublicMode = false;
            return reply("🔒 Mode SELF aktif.");
        }

        if (command === "public" && sender === OWNER_JID) {
            isPublicMode = true;
            return reply("📢 Mode PUBLIC aktif.");
        }

        if (!isPublicMode && sender !== OWNER_JID) return;

        // =============================================================
        // ====================== SAVE ===============================
        // =============================================================
        if (["save", "simpan"].includes(command)) {
            try {
                let fileBuffer = null;
                let mime = null;
                let fileName = null;
                let msgType = "text";

                let mediaMsg =
                    msg.message.imageMessage ||
                    msg.message.videoMessage ||
                    msg.message.audioMessage ||
                    msg.message.documentMessage;

                let target = msg;

                // if save from reply
                if (!mediaMsg && msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;

                    mediaMsg =
                        quoted.imageMessage ||
                        quoted.videoMessage ||
                        quoted.audioMessage ||
                        quoted.documentMessage;

                    if (mediaMsg) target = { message: quoted };
                }

                if (mediaMsg) {
                    mime = mediaMsg.mimetype;
                    fileName = mediaMsg.fileName || null;
                    
                    // --- Logika Penentuan msgType yang Diperbaiki ---
                    if (mime.includes("image") && !mime.includes("gif")) {
                        msgType = "image";
                    } else if (mime.includes("video") || mime.includes("gif")) {
                        msgType = "video";
                    } else if (mime.includes("audio")) {
                        msgType = "audio";
                    } else {
                        // Termasuk PDF dan semua dokumen lainnya
                        msgType = "document";
                    }
                    // ------------------------------------------------

                    fileBuffer = await downloadMediaMessage(target, "buffer");
                }

                const id = saveMessageToDB({
                    sender,
                    chatId: from,
                    type: msgType,
                    text: argText,
                    mimeType: mime,
                    fileName,
                    fileBuffer
                });

                return reply(`✅ Tersimpan.\n• ID: ${id}\n• Nama: ${argText || "-"}\n• Tipe Tersimpan: ${msgType}`);
            } catch (e) {
                console.error(e);
                return reply("❌ Gagal menyimpan file.");
            }
        }

        // =============================================================
        // ====================== LIST ================================
        // =============================================================
        if (command === "list") {
            const rows = listMessagesByChat(from, 20);
            if (!rows.length) return reply("📭 Belum ada data.");

            let out = "📂 *Daftar Data*\n\n";
            for (const r of rows) {
                out += `• ID: ${r.id}\n`;
                out += `  Nama: ${r.text_content || "-"}\n`;
                out += `  File: ${r.file_name || "-"}\n`;
                out += `  Tipe: ${r.msg_type}\n`;
                out += `  Waktu: ${r.created_at}\n\n`;
            }

            return reply(out);
        }

        // =============================================================
        // ====================== DELETE ================================
        // =============================================================
        if (["hapus", "delete", "del"].includes(command)) {
            if (!argText) return reply("❌ Contoh: !hapus 12 atau !hapus all");

            if (argText === "all") {
                const info = deleteAllMessagesByChat(from);
                return reply(`🗑️ Dihapus: ${info.changes} data.`);
            }

            const id = parseInt(argText);
            if (isNaN(id)) return reply("❌ ID harus angka.");

            const info = deleteMessageById(id, from);
            if (!info.changes) return reply("❌ Tidak ditemukan.");

            return reply(`✅ Dihapus ID ${id}`);
        }

        // =============================================================
        // ====================== GET / AMBIL (Perbaikan RePlu) ========
        // =============================================================
        if (["ambil", "get"].includes(command)) {
            const id = parseInt(args[0]);
            if (isNaN(id)) return reply("❌ Contoh: !ambil 5");

            const row = getMessageById(id);
            if (!row) return reply("❌ Tidak ditemukan.");

            if (row.msg_type === "text") return reply(row.text_content || "(kosong)");

            const buf = row.file_data;
            const cap = row.text_content || "";

            // Mengirim FOTO sebagai media biasa (image)
            if (row.msg_type === "image" && !row.mime_type.includes("pdf")) {
                return sock.sendMessage(from, { image: buf, caption: cap }, { quoted: msg });
            }

            // Mengirim VIDEO sebagai media biasa (video)
            if (row.msg_type === "video") {
                return sock.sendMessage(from, { video: buf, caption: cap }, { quoted: msg });
            }

            // Mengirim AUDIO sebagai media biasa (audio)
            if (row.msg_type === "audio") {
                return sock.sendMessage(from, { audio: buf, ptt: false }, { quoted: msg });
            }
            
            // Mengirim PDF dan dokumen/media lain sebagai DOKUMEN
            return sock.sendMessage(
                from,
                {
                    document: buf,
                    fileName: row.file_name || "file." + row.mime_type.split("/").pop(),
                    mimetype: row.mime_type || "application/octet-stream",
                    caption: cap
                },
                { quoted: msg }
            );
        }

        // =====================================================================
        // ========================== JPG → PDF =================================
        // =====================================================================
        if (command === "jpg2pdf") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);
                if (!row) return reply("❌ Tidak ditemukan.");
                if (!row.mime_type.startsWith("image")) return reply("❌ Bukan gambar.");

                const out = await imageToPdf(row.file_data);

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: (row.text_content || "output") + ".pdf",
                        mimetype: "application/pdf"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal convert JPG → PDF.");
            }
        }

        // =====================================================================
        // ========================== COMPRESS PDF ==============================
        // =====================================================================
        if (command === "compresspdf") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);
                if (!row || row.mime_type !== "application/pdf")
                    return reply("❌ Bukan PDF.");

                const out = await compressPDF(row.file_data);

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "compressed.pdf",
                        mimetype: "application/pdf"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal compress PDF.");
            }
        }

        // =====================================================================
        // ========================== MERGE PDF ===============================
        // =====================================================================
        if (command === "mergepdf") {
            if (args.length < 2) return reply("❌ Contoh: !mergepdf 12 14 15");

            try {
                const ids = args.map(a => parseInt(a)).filter(n => !isNaN(n));
                const buffers = [];

                for (const id of ids) {
                    const row = getMessageById(id);
                    if (!row) return reply(`❌ ID ${id} tidak ditemukan.`);
                    if (row.mime_type !== "application/pdf")
                        return reply(`❌ ID ${id} bukan PDF.`);

                    buffers.push(row.file_data);
                }

                const out = await mergePDFs(buffers);

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "merged.pdf",
                        mimetype: "application/pdf"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal merge PDF.");
            }
        }

        // =====================================================================
        // ========================== SPLIT PDF ================================
        // =====================================================================
        if (command === "splitpdf") {
            try {
                const id = parseInt(args[0]);
                const rangeStr = args[1];
                if (!rangeStr) return reply("❌ Contoh: !splitpdf 12 1-3,5");

                const row = getMessageById(id);
                if (!row || row.mime_type !== "application/pdf")
                    return reply("❌ Bukan PDF.");

                const out = await splitPDF(row.file_data, rangeStr);

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "split.pdf",
                        mimetype: "application/pdf"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal split PDF.");
            }
        }

        // =====================================================================
        // ========================== COMPRESS FOTO =============================
        // =====================================================================
        if (command === "compressfoto") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);
                if (!row || !row.mime_type.startsWith("image"))
                    return reply("❌ Bukan foto.");

                const out = await compressImageBuffer(row.file_data);

                return sock.sendMessage(from, { image: out }, { quoted: msg });
            } catch {
                return reply("❌ Gagal compress foto.");
            }
        }

        // =====================================================================
        // ========================== HD FOTO ==================================
        // =====================================================================
        if (command === "hdfoto") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);
                if (!row || !row.mime_type.startsWith("image"))
                    return reply("❌ Bukan foto.");

                const out = await enhanceImageBuffer(row.file_data);

                return sock.sendMessage(from, { image: out }, { quoted: msg });
            } catch {
                return reply("❌ Gagal HD foto.");
            }
        }

        // =====================================================================
        // ========================== REMOVE BG ================================
        // =====================================================================
        if (command === "removebg") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);
                if (!row || !row.mime_type.startsWith("image"))
                    return reply("❌ Bukan foto.");

                const out = await removeBackground(row.file_data);

                return sock.sendMessage(
                    from,
                    {
                        image: out,
                        mimetype: "image/png",
                        caption: "Background berhasil dihapus."
                    },
                    { quoted: msg }
                );
            } catch (e) {
                console.log(e);
                return reply("❌ Gagal remove background.");
            }
        }

        // =====================================================================
        // ========================== CLOUDCONVERT ==============================
        // =====================================================================

        const doCC = async (row, from, to) => {
            if (!CLOUDCONVERT_API_KEY || CLOUDCONVERT_API_KEY.includes("ISI_API")) {
                return reply("❌ CloudConvert API Key belum diisi.");
            }
            try {
                return await convertCloudConvert(row.file_data, from, to);
            } catch (e) {
                console.log(e);
                throw new Error("CloudConvert gagal");
            }
        };

        // PDF → Word
        if (command === "pdf2word") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);

                if (!row || row.mime_type !== "application/pdf")
                    return reply("❌ Bukan PDF.");

                const out = await doCC(row, "pdf", "docx");

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "output.docx",
                        caption: "Selesai convert PDF → Word"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal convert PDF → Word.");
            }
        }

        // Word → PDF
        if (command === "word2pdf") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);

                if (!row.mime_type.includes("word") &&
                    !row.mime_type.includes("officedocument.wordprocessingml.document"))
                    return reply("❌ Bukan file Word.");

                const out = await doCC(row, "docx", "pdf");

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "output.pdf",
                        caption: "Selesai convert Word → PDF"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal convert Word → PDF.");
            }
        }

        // Excel → PDF
        if (command === "excel2pdf") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);

                if (!row.mime_type.includes("spreadsheet") &&
                    !row.mime_type.includes("excel"))
                    return reply("❌ Bukan Excel.");

                const out = await doCC(row, "xlsx", "pdf");

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "output.pdf",
                        caption: "Selesai convert Excel → PDF"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal convert Excel → PDF.");
            }
        }

        // PDF → Excel
        if (command === "pdf2excel") {
            try {
                const id = parseInt(args[0]);
                const row = getMessageById(id);

                if (!row || row.mime_type !== "application/pdf")
                    return reply("❌ Bukan PDF.");

                const out = await doCC(row, "pdf", "xlsx");

                return sock.sendMessage(
                    from,
                    {
                        document: out,
                        fileName: "output.xlsx",
                        caption: "Selesai convert PDF → Excel"
                    },
                    { quoted: msg }
                );
            } catch {
                return reply("❌ Gagal convert PDF → Excel.");
            }
        }

        // =====================================================================
        // ========================== MENU =====================================
        // =====================================================================
        if (command === "menu") {
            return reply(
                `📘 *MENU BOT*\n\n` +
                "📦 MANAGER FILE\n" +
                "• !save <nama> (reply media/teks)\n" +
                "• !list\n" +
                "• !ambil <id>\n" +
                "• !hapus <id>\n" +
                "• !hapus all\n\n" +

                "📄 KONVERSI CLOUDCONVERT\n" +
                "• !pdf2word <id>\n" +
                "• !word2pdf <id>\n" +
                "• !excel2pdf <id>\n" +
                "• !pdf2excel <id>\n\n" +

                "📑 PDF TOOLS\n" +
                "• !jpg2pdf <id>\n" +
                "• !compresspdf <id>\n" +
                "• !mergepdf <id1> <id2> ...\n" +
                "• !splitpdf <id> <range>\n\n" +

                "🖼️ FOTO TOOLS\n" +
                "• !compressfoto <id>\n" +
                "• !hdfoto <id>\n" +
                "• !removebg <id>\n\n" +

                "⚙ MODE BOT\n" +
                "• !self / !public"
            );
        }

    }); // end handler
}

startBot();
