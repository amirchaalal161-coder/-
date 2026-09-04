// index.js — بوت النقاط + البنك + الرهان (واتساب)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ================= إعدادات ثابتة =================
const DEV_NUMBER = "213561055648"; // بدون + وبدون @s.whatsapp.net
const DEV_JID = DEV_NUMBER + "@s.whatsapp.net";
const PREFIX = "."; // كل امر يجب أن يبدأ بنقطة
const DB_PATH = path.join(__dirname, "db.json");
const ELITE_START_POINTS = 250000;
const BANK_DEPOSIT_FEE = 0.10; // 10%

// ================= قاعدة بيانات بسيطة (JSON) =================
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: {}, groups: {}, eliteJid: null, bannedUsers: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = loadDB();
function getUser(jid) {
  if (!db.users[jid]) {
    db.users[jid] = {
      name: null,
      points: 0,
      weeklyPoints: 0,
      bank: 0,
      purchases: 0,
      joinedAt: null,
      oneStreak: 0, // عداد الرهانات المتتالية بنقطة واحدة (الجلتش)
    };
  }
  return db.users[jid];
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit" });
}
// ================= صلاحيات =================
function isDev(jid) {
  return jid && jid.startsWith(DEV_NUMBER);
}
function isElite(jid) {
  return db.eliteJid === jid;
}
async function isGroupAdmin(sock, groupId, jid) {
  try {
    const meta = await sock.groupMetadata(groupId);
    const p = meta.participants.find((x) => x.id === jid);
    return !!p && (p.admin === "admin" || p.admin === "superadmin");
  } catch {
    return false;
  }
}
// ================= أدوات مساعدة =================
function extractMentionedJid(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.mentionedJid?.length) return ctx.mentionedJid[0];
  return null;
}
function getText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ""
  );
}
const HELP_TEXT = `╭─「 📜 *قائمة الأوامر* 」
│
│ 👤 *أوامر الأعضاء*
│ ${PREFIX}تسجيل <الاسم>
│ ${PREFIX}نقاطي
│ ${PREFIX}بنك
│ ${PREFIX}بنك ايداع <عدد>
│ ${PREFIX}بنك سحب <عدد>
│ ${PREFIX}رهان <عدد>
│ ${PREFIX}تحويل <عدد> @شخص
│ ${PREFIX}نخبة
│ ${PREFIX}مطور
│ ${PREFIX}اوامر
│
│ 🛡️ *أوامر المشرفين*
│ ${PREFIX}تشغيل
│ ${PREFIX}ايقاف
│
│ 👑 *أوامر النخبة*
│ ${PREFIX}حظر @شخص
│ ${PREFIX}فك حظر @شخص
╰──────────────────`;
// ================= معالجة الرهان (مع الجلتش المطلوب) =================
function placeBet(user, amount) {
  let winChance = 0.5;
  let bonusUsed = false;
  if (user.oneStreak >= 3) {
    winChance = 0.9;
    bonusUsed = true;
  }
  const won = Math.random() < winChance;
  if (won) {
    user.points += amount;
  } else {
    user.points -= amount;
  }
  // تحديث عداد التتالي
  if (bonusUsed) {
    user.oneStreak = 0; // بعد استخدام البونص يصفر العداد
  } else if (amount === 1) {
    user.oneStreak += 1;
  } else {
    user.oneStreak = 0;
  }
  return won;
}
// ================= بدء البوت =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info"));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("امسح رمز QR التالي من واتساب (الأجهزة المرتبطة):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("انقطع الاتصال، إعادة المحاولة:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ البوت متصل الآن");
    }
  });
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid; // آيدي الجروب أو الخاص
      const isGroup = from.endsWith("@g.us");
      const sender = isGroup ? msg.key.participant : from;
      const text = getText(msg).trim();
      if (!text.startsWith(PREFIX)) return; // يجب أن تبدأ بنقطة
      const body = text.slice(PREFIX.length).trim();
      const [cmdRaw, ...args] = body.split(/\s+/);
      const cmd = cmdRaw;
      const argStr = args.join(" ").trim();
      const reply = (t, mentions = []) =>
        sock.sendMessage(from, { text: t, mentions }, { quoted: msg });
      // ------------ تشغيل / ايقاف (لا تخضع لفحص التفعيل ولا للحظر) ------------
      if (cmd === "تشغيل") {
        if (!isGroup) return reply("هذا الأمر يعمل داخل الجروبات فقط.");
        const allowed = isDev(sender) || (await isGroupAdmin(sock, from, sender));
        if (!allowed) return reply("هذا الأمر مخصص لمشرفي الجروب أو المطور فقط.");
        db.groups[from] = db.groups[from] || {};
        db.groups[from].active = true;
        saveDB(db);
        return reply("✅ تم تشغيل البوت في هذا الجروب.");
      }
      if (cmd === "ايقاف") {
        if (!isGroup) return reply("هذا الأمر يعمل داخل الجروبات فقط.");
        const allowed = isDev(sender) || (await isGroupAdmin(sock, from, sender));
        if (!allowed) return reply("هذا الأمر مخصص لمشرفي الجروب أو المطور فقط.");
        db.groups[from] = db.groups[from] || {};
        db.groups[from].active = false;
        saveDB(db);
        return reply("🛑 تم إيقاف البوت في هذا الجروب.");
      }
      // ------------ فحص التفعيل (داخل الجروبات) ------------
      if (isGroup && !(db.groups[from] && db.groups[from].active)) {
        return; // البوت متوقف في هذا الجروب، يتجاهل بقية الأوامر
      }
      // ------------ فحص الحظر ------------
      if (db.bannedUsers[sender]) {
        return reply("🚫 أنت محظور من استخدام البوت.");
      }
      const user = getUser(sender);
      switch (cmd) {
        case "تسجيل": {
          if (!argStr) return reply("اكتب اسمك بعد كلمة تسجيل. مثال: .تسجيل احمد");
          user.name = argStr;
          user.joinedAt = user.joinedAt || Date.now();
          saveDB(db);
          return reply(`تم تسجيل: *${argStr}* @${sender.split("@")[0]}\nمرحبا بك اتمنى تستمتع فالبوت مع اصحابك`, [sender]);
        }
        case "نقاطي": {
          const card =
`╭─「 👤 *بطاقتك* 」
│
│ اللقب: *${user.name || "غير مسجل"}*
│ 📱 @${sender.split("@")[0]}
│ 💰 النقاط الكلية: *${user.points}*
│ 📅 هذا الأسبوع: *${user.weeklyPoints}*
│ 🛒 مشتريات: ${user.purchases}
│ 📆 انضم: ${user.joinedAt ? fmtDate(user.joinedAt) : "غير معروف"}
╰──────────────────`;
          return reply(card, [sender]);
        }
        case "بنك": {
          if (args[0] === "ايداع") {
            const amount = parseInt(args[1], 10);
            if (!amount || amount <= 0) return reply("اكتب عدد صحيح موجب. مثال: .بنك ايداع 100");
            if (amount > user.points) return reply("ليس لديك نقاط كافية لهذا الإيداع.");
            const fee = Math.floor(amount * BANK_DEPOSIT_FEE);
            const deposited = amount - fee;
            user.points -= amount;
            user.bank += deposited;
            saveDB(db);
            return reply(
`✅ *تم الإيداع في البنك!*
💸 المبلغ المطلوب: *${amount}* نقطة
💳 رسوم الإيداع (10%): *${fee}* نقطة
🏦 تم إيداع: *${deposited}* نقطة
💰 نقاطك الآن: *${user.points}*
🏦 رصيد البنك: *${user.bank}*`
            );
          }
          if (args[0] === "سحب") {
            let amount = args[1] ? parseInt(args[1], 10) : user.bank;
            if (!amount || amount <= 0) return reply("لا يوجد رصيد للسحب.");
            if (amount > user.bank) return reply("رصيد بنكك أقل من المبلغ المطلوب.");
            user.bank -= amount;
            user.points += amount;
            saveDB(db);
            return reply(
`تم السحب من البنك 🏦
نقاطك الان: ${user.points}
رصيد البنك: ${user.bank}`
            );
          }
          const bankCard =
`╭─「 🏦 *بنكك* 」
│
│ 💰 نقاطك الحالية: *${user.points}*
│ 🏦 رصيد البنك: *${user.bank}*
│
│ 📌 الإيداع: *${PREFIX}بنك ايداع <مبلغ>*
│ 📌 السحب: *${PREFIX}بنك سحب* (أو *${PREFIX}بنك سحب <مبلغ>*)
│
│ ⚠️ رسوم الإيداع: *10%* من كل إيداع
│ ✅ البنك لا يُصفَّر عند التجديد الأسبوعي
╰──────────────────`;
          return reply(bankCard);
        }
        case "رهان": {
          const amount = parseInt(args[0], 10);
          if (!amount || amount <= 0) return reply("اكتب عدد صحيح موجب. مثال: .رهان 50");
          if (amount > user.points) return reply("ليس لديك نقاط كافية لهذا الرهان.");
          const won = placeBet(user, amount);
          user.weeklyPoints += won ? amount : 0;
          saveDB(db);
          if (won) {
            return reply(
`🎰 *ربحت الرهان!* 🎉
💰 مبلغ الرهان: *${amount}* نقطة
✨ *الحظ حالفك — ربحت مثل مبلغ رهانك!*
📈 +*${amount}* نقطة
💼 رصيدك الحالي: *${user.points}*
@${sender.split("@")[0]} استمر تراهن! 🍀`,
              [sender]
            );
          } else {
            return reply(
`💀 *خسرت الرهان!*
💰 مبلغ الرهان: *${amount}* نقطة
☠️ *ما حالفك الحظ هذي المرة*
💼 رصيدك الحالي: *${user.points}*
@${sender.split("@")[0]} حظ أفضل في المرة القادمة 😅`,
              [sender]
            );
          }
        }
        case "تحويل": {
          const amount = parseInt(args[0], 10);
          const targetJid = extractMentionedJid(msg);
          if (!amount || amount <= 0 || !targetJid) {
            return reply("الصيغة: .تحويل <عدد> @الشخص");
          }
          if (amount > user.points) return reply("ليس لديك نقاط كافية لهذا التحويل.");
          if (targetJid === sender) return reply("لا يمكنك تحويل نقاط لنفسك.");
          const target = getUser(targetJid);
          user.points -= amount;
          target.points += amount;
          saveDB(db);
          return reply(
            `✅ تم تحويل *${amount}* نقطة من @${sender.split("@")[0]} إلى @${targetJid.split("@")[0]}`,
            [sender, targetJid]
          );
        }
        case "نخبة": {
          if (db.eliteJid) {
            if (db.eliteJid === sender) return reply("أنت بالفعل النخبة الوحيد 👑");
            return reply(
              `النخبة الوحيد هو @${db.eliteJid.split("@")[0]} 👑\n@${sender.split("@")[0]} يلا هش هش 😹`,
              [db.eliteJid, sender]
            );
          }
          db.eliteJid = sender;
          user.points += ELITE_START_POINTS;
          saveDB(db);
          return reply(
            `👑 تهانينا! أنت الآن *النخبة* الوحيد في البوت.\n💰 حصلت على *${ELITE_START_POINTS}* نقطة.`,
            [sender]
          );
        }
        case "مطور": {
          return reply(
`👨‍💻 المطور هو: +${DEV_NUMBER}
🇩🇿 تحيا الجزائر`
          );
        }
        case "حظر": {
          if (!isElite(sender)) return reply("هذا الأمر مخصص للنخبة فقط.");
          const targetJid = extractMentionedJid(msg);
          if (!targetJid) return reply("منشن الشخص المراد حظره. مثال: .حظر @شخص");
          db.bannedUsers[targetJid] = true;
          saveDB(db);
          return reply(`🚫 تم حظر @${targetJid.split("@")[0]} من استخدام البوت.`, [targetJid]);
        }
        case "فك": {
          if (args[0] !== "حظر") break;
          if (!isElite(sender)) return reply("هذا الأمر مخصص للنخبة فقط.");
          const targetJid = extractMentionedJid(msg);
          if (!targetJid) return reply("منشن الشخص المراد فك حظره. مثال: .فك حظر @شخص");
          delete db.bannedUsers[targetJid];
          saveDB(db);
          return reply(`✅ تم فك الحظر عن @${targetJid.split("@")[0]}`, [targetJid]);
        }
        case "اوامر": {
          return reply(HELP_TEXT);
        }
        default: {
          return reply("اسف الامر غير موجود 🙏");
        }
      }
      // حالة "فك" بدون "حظر" بعدها
      return reply("اسف الامر غير موجود 🙏");
    } catch (err) {
      console.error("خطأ في معالجة الرسالة:", err);
    }
  });
  return sock;
}
// ================= إعادة تعيين نقاط الأسبوع (كل أحد الساعة 00:00) =================
cron.schedule("0 0 * * 0", () => {
  db = loadDB();
  for (const jid in db.users) {
    db.users[jid].weeklyPoints = 0;
  }
  saveDB(db);
  console.log("🔄 تم تصفير نقاط الأسبوع لكل المستخدمين (البنك لم يُمس).");
});
// ================= سيرفر خفيف لإبقاء البوت مستيقظ على Render =================
const app = express();
app.get("/", (req, res) => res.send("🤖 البوت شغال."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 سيرفر البقاء حي يعمل على المنفذ ${PORT}`));
startBot();
