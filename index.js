/**
 * WhatsApp Utility Bot – FINAL CLEAN
 * FIX:
 *  - FormData + fetch (Node.js compatible)
 *  - RemoveBG stable
 *  - CloudConvert stable
 *  - Baileys auto reconnect
 *  - SQLite stable
 */

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const P = require("pino");
const Database = require("better-sqlite3");
const CloudConvert = require("cloudconvert");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

// FIX Node.js removebg
const FormData = require("form-data");
const fetch = require("node-fetch");

// =============================
//   API KEY (ISI SENDIRI)
// =============================
const CLOUDCONVERT_API_KEY = "ISI_SENDIRI";
const REMOVE_BG_API_KEY = "QDGnRLDXXPqc9iXDUFCVUXic";
const PREFIX = "!";
const OWNER_JID = "6281578859076@s.whatsapp.net";

let isPublicMode = true;
let botNumber = null;

// =============================
//        DATABASE
// =============================
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

function saveDB(data) {
    return db.prepare(`
        INSERT INTO wa_messages 
        (sender_jid, chat_jid, msg_type, text_content, mime_type, file_name, file_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.sender,
        data.chatId,
        data.type,
        data.text,
        data.mimeType,
        data.fileName,
        data.fileBuffer
    ).lastInsertRowid;
}

function listDB(chatId, limit = 20) {
    return db.prepare(`SELECT * FROM wa_messages WHERE chat_jid=? ORDER BY id DESC LIMIT ?`)
        .all(chatId, limit);
}

function getDB(id) {
    return db.prepare(`SELECT * FROM wa_messages WHERE id=?`).get(id);
}

function delOneDB(id, chatId) {
    return db.prepare(`DELETE FROM wa_messages WHERE id=? AND chat_jid=?`)
        .run(id, chatId);
}

function delAllDB(chatId) {
    return db.prepare(`DELETE FROM wa_messages WHERE chat_jid=?`).run(chatId);
}

// =============================
//      UTILITIES
// =============================
async function compressImage(buf) {
    return sharp(buf).jpeg({ quality: 60 }).toBuffer();
}

async function enhanceImage(buf) {
    const img = sharp(buf);
    const meta = await img.metadata();
    return img.resize({ width: Math.round((meta.width || 800) * 1.5) })
        .sharpen()
        .jpeg({ quality: 90 })
        .toBuffer();
}

async function removeBG(buf) {
    const fd = new FormData();
    fd.append("image_file", buf, { filename: "img.jpg" });
    fd.append("size", "auto");

    const res = await fetch("https://api.remove.bg/v1.0/removebg", {
        method: "POST",
        headers: { "X-Api-Key": REMOVE_BG_API_KEY },
        body: fd
    });

    if (!res.ok) throw new Error(await res.text());
    return Buffer.from(await res.arrayBuffer());
}

// PDF Tools
async function jpgToPdf(buf) {
    const pdf = await PDFDocument.create();
    let img;

    try { img = await pdf.embedJpg(buf); }
    catch { img = await pdf.embedPng(buf); }

    const page = pdf.addPage();
    const { width, height } = img;

    const scale = Math.min(
        page.getWidth() / width,
        page.getHeight() / height
    );

    page.drawImage(img, {
        x: (page.getWidth() - width * scale) / 2,
        y: (page.getHeight() - height * scale) / 2,
        width: width * scale,
        height: height * scale
    });

    return Buffer.from(await pdf.save());
}

async function compressPDF(buf) {
    const pdf = await PDFDocument.load(buf);
    return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

async function mergePDF(arr) {
    const merged = await PDFDocument.create();
    for (const buf of arr) {
        const pdf = await PDFDocument.load(buf);
        const cp = await merged.copyPages(pdf, pdf.getPageIndices());
        cp.forEach(p => merged.addPage(p));
    }
    return Buffer.from(await merged.save());
}

function parseRange(str, max) {
    const out = new Set();
    const parts = str.split(",");

    for (const p of parts) {
        if (p.includes("-")) {
            let [a, b] = p.split("-").map(n => parseInt(n));
            a = Math.max(1, a);
            b = Math.min(max, b);
            for (let i = a; i <= b; i++) out.add(i);
        } else {
            const n = parseInt(p);
            if (n >= 1 && n <= max) out.add(n);
        }
    }

    return [...out];
}

async function splitPDF(buf, rangeStr) {
    const pdf = await PDFDocument.load(buf);
    const pages = pdf.getPageCount();
    const ranges = parseRange(rangeStr, pages);

    const newPDF = await PDFDocument.create();
    const cp = await newPDF.copyPages(pdf, ranges.map(i => i - 1));
    cp.forEach(p => newPDF.addPage(p));

    return Buffer.from(await newPDF.save());
}

// CloudConvert (Simple Mode)
const cloud = new CloudConvert(CLOUDCONVERT_API_KEY, false);

async function ccConvert(buf, from, to) {
    const job = await cloud.jobs.create({
        tasks: {
            import: {
                operation: "import/base64",
                file: buf.toString("base64"),
                filename: `input.${from}`
            },
            convert: {
                operation: "convert",
                input: "import",
                output_format: to
            },
            export: {
                operation: "export/url",
                input: "convert"
            }
        }
    });

    const exp = job.tasks.find(t => t.name === "export");
    const file = exp.result.files[0];

    const res = await fetch(file.url);
    return Buffer.from(await res.arrayBuffer());
}

// =============================
//        START BOT
// =============================
async function start() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: false
    });

    sock.ev.on("connection.update", ({ connection, qr }) => {
        if (qr) {
            console.log("SCAN QR:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            botNumber = sock.user.id;
            console.log(`BOT ONLINE: ${botNumber}`);
        }
        if (connection === "close") {
            console.log("Reconnecting...");
            start();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // =============================
    //     MESSAGE HANDLER
    // =============================
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;

        let text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            "";

        text = text.trim();
        if (!text.startsWith(PREFIX)) return;

        const full = text.slice(1).toLowerCase().trim();
        const [command, ...params] = full.split(" ");
        const arg = params.join(" ").trim();

        const reply = t => sock.sendMessage(from, { text: t }, { quoted: msg });

        // ================================
        // MODE
        // ================================
        if (command === "self" && sender === OWNER_JID) {
            isPublicMode = false;
            return reply("Mode SELF aktif.");
        }

        if (command === "public" && sender === OWNER_JID) {
            isPublicMode = true;
            return reply("Mode PUBLIC aktif.");
        }

        if (!isPublicMode && sender !== OWNER_JID) return;

        // ================================
        // SAVE
        // ================================
        if (["save", "simpan"].includes(command)) {
            try {
                let media =
                    msg.message.imageMessage ||
                    msg.message.videoMessage ||
                    msg.message.audioMessage ||
                    msg.message.documentMessage;

                let target = msg;

                if (!media && msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    const q = msg.message.extendedTextMessage.contextInfo.quotedMessage;

                    media =
                        q.imageMessage ||
                        q.videoMessage ||
                        q.audioMessage ||
                        q.documentMessage;

                    if (media) target = { message: q };
                }

                let buf = null, mime = null, fname = null, type = "text";

                if (media) {
                    mime = media.mimetype;
                    fname = media.fileName || null;

                    if (mime.includes("image") && !mime.includes("gif")) type = "image";
                    else if (mime.includes("video")) type = "video";
                    else if (mime.includes("audio")) type = "audio";
                    else type = "document";

                    buf = await downloadMediaMessage(target, "buffer");
                }

                const id = saveDB({
                    sender,
                    chatId: from,
                    type,
                    text: arg,
                    mimeType: mime,
                    fileName: fname,
                    fileBuffer: buf
                });

                reply(`Tersimpan.\nID: ${id}\nTipe: ${type}`);
            } catch (e) {
                console.log(e);
                reply("Gagal menyimpan.");
            }
        }

        // ================================
        // LIST
        // ================================
        if (command === "list") {
            const rows = listDB(from);
            if (!rows.length) return reply("Tidak ada data.");

            let out = "📂 *LIST DATA*\n\n";
            rows.forEach(r => {
                out += `• ID: ${r.id}\nNama: ${r.text_content || "-"}\nFile: ${r.file_name || "-"}\nTipe: ${r.msg_type}\nWaktu: ${r.created_at}\n\n`;
            });

            return reply(out);
        }

        // ================================
        // DELETE
        // ================================
        if (["del", "delete", "hapus"].includes(command)) {
            if (arg === "all") {
                delAllDB(from);
                return reply("Semua data dihapus.");
            }

            const id = parseInt(arg);
            if (isNaN(id)) return reply("ID tidak valid.");

            const res = delOneDB(id, from);
            if (!res.changes) return reply("Tidak ditemukan.");

            return reply(`ID ${id} dihapus.`);
        }

        // ================================
        // GET
        // ================================
        if (["get", "ambil"].includes(command)) {
            const id = parseInt(params[0]);
            if (isNaN(id)) return reply("Contoh: !ambil 5");

            const row = getDB(id);
            if (!row) return reply("Tidak ditemukan.");

            if (row.msg_type === "text")
                return reply(row.text_content || "-");

            const buf = row.file_data;
            const cap = row.text_content || "";

            if (row.msg_type === "image")
                return sock.sendMessage(from, { image: buf, caption: cap }, { quoted: msg });

            if (row.msg_type === "video")
                return sock.sendMessage(from, { video: buf, caption: cap }, { quoted: msg });

            if (row.msg_type === "audio")
                return sock.sendMessage(from, { audio: buf }, { quoted: msg });

            return sock.sendMessage(from, {
                document: buf,
                fileName: row.file_name || "file",
                mimetype: row.mime_type || "application/octet-stream",
                caption: cap
            }, { quoted: msg });
        }

        // ================================
        //pdf tools
        //===============================
        if (command === "jpg2pdf") {
            try {
                const id = parseInt(params[0]);
                const row = getDB(id);
                if (!row.mime_type.startsWith("image"))
                    return reply("Bukan gambar.");

                const out = await jpgToPdf(row.file_data);
                return sock.sendMessage(from, {
                    document: out,
                    fileName: "output.pdf",
                    mimetype: "application/pdf"
                }, { quoted: msg });

            } catch {
                reply("Gagal convert.");
            }
        }

        if (command === "compresspdf") {
            try {
                const id = parseInt(params[0]);
                const row = getDB(id);
                if (row.mime_type !== "application/pdf")
                    return reply("Bukan PDF.");

                const out = await compressPDF(row.file_data);
                return sock.sendMessage(from, {
                    document: out,
                    fileName: "compressed.pdf"
                }, { quoted: msg });
            } catch {
                reply("Gagal compress.");
            }
        }

        if (command === "mergepdf") {
            try {
                const ids = params.map(n => parseInt(n)).filter(n => !isNaN(n));
                const buffs = [];

                for (const id of ids) {
                    const row = getDB(id);
                    if (!row.mime_type.includes("pdf"))
                        return reply(`ID ${id} bukan PDF`);
                    buffs.push(row.file_data);
                }

                const out = await mergePDF(buffs);
                return sock.sendMessage(from, {
                    document: out,
                    fileName: "merged.pdf"
                }, { quoted: msg });

            } catch {
                reply("Gagal merge.");
            }
        }

        if (command === "splitpdf") {
            try {
                const id = parseInt(params[0]);
                const range = params[1];
                if (!range) return reply("Contoh: !splitpdf 12 1-3,5");

                const row = getDB(id);
                if (row.mime_type !== "application/pdf")
                    return reply("Bukan PDF.");

                const out = await splitPDF(row.file_data, range);
                return sock.sendMessage(from, {
                    document: out,
                    fileName: "split.pdf"
                }, { quoted: msg });

            } catch {
                reply("Gagal split.");
            }
        }

        // ================================
        // FOTO TOOLS
        // ================================
        if (command === "compressfoto") {
            try {
                const id = parseInt(params[0]);
                const row = getDB(id);

                if (!row.mime_type.startsWith("image"))
                    return reply("Bukan foto.");

                const out = await compressImage(row.file_data);
                return sock.sendMessage(from, { image: out }, { quoted: msg });

            } catch {
                reply("Gagal compress foto.");
            }
        }

        if (command === "hdfoto") {
            try {
                const id = parseInt(params[0]);
                const row = getDB(id);

                if (!row.mime_type.startsWith("image"))
                    return reply("Bukan foto.");

                const out = await enhanceImage(row.file_data);
                return sock.sendMessage(from, { image: out }, { quoted: msg });

            } catch {
                reply("Gagal HD foto.");
            }
        }

        if (command === "removebg") {
            try {
                const id = parseInt(params[0]);
                const row = getDB(id);

                if (!row.mime_type.startsWith("image"))
                    return reply("Bukan foto.");

                const out = await removeBG(row.file_data);
                return sock.sendMessage(from, {
                    image: out,
                    caption: "Background dihapus."
                }, { quoted: msg });

            } catch (e) {
                console.log(e);
                reply("Gagal remove BG.");
            }
        }

        // ================================
        // CLOUDCONVERT
        // ================================
        async function doCC(row, from, to) {
            if (!CLOUDCONVERT_API_KEY || CLOUDCONVERT_API_KEY === "ISI_SENDIRI")
                return reply("API CloudConvert belum diisi.");

            try {
                return await ccConvert(row.file_data, from, to);
            } catch (e) {
                console.log(e);
                reply("CloudConvert gagal.");
            }
        }

        if (command === "pdf2word") {
            const id = parseInt(params[0]);
            const row = getDB(id);
            if (!row.mime_type.includes("pdf"))
                return reply("Bukan PDF.");

            const out = await doCC(row, "pdf", "docx");
            return sock.sendMessage(from, {
                document: out,
                fileName: "output.docx",
                caption: "Selesai convert."
            }, { quoted: msg });
        }

        if (command === "word2pdf") {
            const id = parseInt(params[0]);
            const row = getDB(id);
            if (!row.mime_type.includes("word"))
                return reply("Bukan Word.");

            const out = await doCC(row, "docx", "pdf");
            return sock.sendMessage(from, {
                document: out,
                fileName: "output.pdf"
            }, { quoted: msg });
        }

        if (command === "excel2pdf") {
            const id = parseInt(params[0]);
            const row = getDB(id);
            if (!row.mime_type.includes("sheet"))
                return reply("Bukan Excel.");

            const out = await doCC(row, "xlsx", "pdf");
            return sock.sendMessage(from, {
                document: out,
                fileName: "output.pdf"
            }, { quoted: msg });
        }

        if (command === "pdf2excel") {
            const id = parseInt(params[0]);
            const row = getDB(id);
            if (!row.mime_type.includes("pdf"))
                return reply("Bukan PDF.");

            const out = await doCC(row, "pdf", "xlsx");
            return sock.sendMessage(from, {
                document: out,
                fileName: "output.xlsx"
            }, { quoted: msg });
        }

        // ================================
        // MENU
        // ================================
        if (command === "menu") {
            return reply(
                `📘 MENU BOT\n\n` +
                `📦 FILE MANAGER\n` +
                `• !save <nama>\n` +
                `• !list\n` +
                `• !ambil <id>\n` +
                `• !hapus <id/all>\n\n` +

                `📄 CLOUDCONVERT\n` +
                `• !pdf2word <id>\n` +
                `• !word2pdf <id>\n` +
                `• !excel2pdf <id>\n` +
                `• !pdf2excel <id>\n\n` +

                `📑 PDF TOOLS\n` +
                `• !jpg2pdf <id>\n` +
                `• !compresspdf <id>\n` +
                `• !mergepdf <id1> <id2>...\n` +
                `• !splitpdf <id> <range>\n\n` +

                `🖼️ FOTO\n` +
                `• !compressfoto <id>\n` +
                `• !hdfoto <id>\n` +
                `• !removebg <id>\n\n` +

                `⚙ MODE\n` +
                `• !self / !public`
            );
        }

    });
}

start();

