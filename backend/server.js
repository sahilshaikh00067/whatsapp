const express = require("express");
const cors = require("cors");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());



async function createDevice(deviceId) {

  if (clients[deviceId]) {
    console.log("Already running:", deviceId);
    return;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: deviceId }),

puppeteer: {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-animations",
    "--no-first-run"
  ]
}
  });

  clients[deviceId] = client; // 🔥 IMPORTANT (before init)

  client.on("qr", async (qr) => {
    qrCodes[deviceId] = await qrcode.toDataURL(qr);
    readyMap[deviceId] = false;
  });

  client.on("ready", () => {
    readyMap[deviceId] = true;

    const info = client.info;

    infoMap[deviceId] = {
      wid: info?.wid,
      pushname: info?.pushname
    };

    console.log("✅ Ready:", deviceId);
  });

  client.on("disconnected", async () => {
    console.log("❌ Disconnected:", deviceId);

    readyMap[deviceId] = false;

    try {
      await client.destroy();
    } catch { }

    delete clients[deviceId];

    // 🔥 auto reconnect (safe)
    setTimeout(() => {
      createDevice(deviceId);
    }, 5000);
  });

  await client.initialize();
}


// ===============================
// 🔥 GET DEVICE INFO (FIX)
// ===============================


app.use("/uploads", express.static("uploads"));
app.get("/get-device", (req, res) => {
  const { deviceId } = req.query;

  if (!deviceId) {
    return res.json({ status: "failed" });
  }

  const info = infoMap[deviceId];

  if (!info) {
    return res.json({ status: "not_ready" });
  }

  res.json({
    number: info.wid?.user || "",
    name: info.pushname || ""
  });
});

// ===============================
// FILE UPLOAD
// ===============================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 3 * 1024 * 1024 }
});

// ===============================
// STORAGE
// ===============================
const clients = {};
const qrCodes = {};
const readyMap = {};
const infoMap = {};

// ===============================
// CREATE DEVICE
// ===============================
app.get("/create-device", async (req, res) => {
  const { deviceId } = req.query;

  if (Object.keys(clients).length >= 10) {
    return res.json({
      status: "limit",
      message: "Max 10 devices allowed"
    });
  }

  if (!deviceId) {
    return res.json({ status: "failed", message: "deviceId required" });
  }

  if (clients[deviceId]) {
    return res.json({
      status: "already_exists",
      ready: readyMap[deviceId] || false
    });
  }

  try {
    await createDevice(deviceId);

    return res.json({
      status: "created",
      deviceId
    });

  } catch (err) {
    console.log(err);
    res.json({ status: "error", error: err.message });
  }
});
// ===============================
// GET QR
// ===============================
app.get("/get-qr", (req, res) => {
  const { deviceId } = req.query;

  res.json({
    qr: qrCodes[deviceId] || "",
    ready: readyMap[deviceId] || false
  });
});


app.get("/delete-device", async (req, res) => {
  const { deviceId } = req.query;

  const client = clients[deviceId];

  if (!client) {
    return res.json({ status: "not_found" });
  }

  try {
    await client.destroy();

    delete clients[deviceId];
    delete readyMap[deviceId];
    delete infoMap[deviceId];
    delete qrCodes[deviceId];

    res.json({ status: "deleted" });

  } catch (err) {
    res.json({ status: "error" });
  }
});

// ===============================
// 🔥 FINAL SEND BULK (FIXED)
// ===============================
app.post("/send-bulk", upload.any(), async (req, res) => {

  let numbers = req.body.numbers || [];
  const message = req.body.message || "";
  const mode = req.body.mode || "normal";
  const files = req.files || [];

  if (!Array.isArray(numbers)) {
    numbers = [numbers];
  }

  const deviceIds = Object.keys(clients).filter(id => readyMap[id]);

  if (deviceIds.length === 0) {
    return res.json({ status: "no_device" });
  }

  // =========================
  // 🔥 STEP 3: PREPARE MEDIA (FAST CACHE)
  // =========================
  const dpFile = files.find(f => f.fieldname === "dp");
  const otherFiles = files.filter(f => f.fieldname === "files");

  const preparedDP = dpFile
    ? new MessageMedia(
        dpFile.mimetype,
        fs.readFileSync(path.resolve(dpFile.path), { encoding: "base64" }),
        dpFile.originalname
      )
    : null;

  const preparedFiles = otherFiles.map(file => {
    const filePath = path.resolve(file.path);
    const fileData = fs.readFileSync(filePath, { encoding: "base64" });

    return {
      media: new MessageMedia(file.mimetype, fileData, file.originalname),
      mimetype: file.mimetype,
      path: filePath
    };
  });

  let results = [];

  // =========================
  // 🔥 STEP 5: PARALLEL SEND
  // =========================
  await Promise.all(numbers.map(async (number, index) => {

    const deviceId = deviceIds[index % deviceIds.length];
    const client = clients[deviceId];

    try {
      let num = number.trim().replace(/\D/g, "");
      if (!num.startsWith("91")) num = "91" + num;

      const chatId = num + "@c.us";

      // =========================
      // 🔥 MODE: DP CAMPAIGN
      // =========================
      if (mode === "dp") {

        // DP + MESSAGE (single bubble)
        if (preparedDP) {
          await client.sendMessage(chatId, preparedDP, {
            caption: message || "",
            sendMediaAsDocument: false
          });
        } else if (message) {
          await client.sendMessage(chatId, message);
        }

        // other media
        for (let file of preparedFiles) {
          await client.sendMessage(chatId, file.media, {
            sendMediaAsDocument: !file.mimetype.startsWith("image/")
          });
        }

      }

      // =========================
      // 🔥 MODE: NORMAL
      // =========================
      else {

        if (message) {
          await client.sendMessage(chatId, message);
        }

        for (let file of preparedFiles) {
          await client.sendMessage(chatId, file.media, {
            sendMediaAsDocument: !file.mimetype.startsWith("image/")
          });
        }
      }

      results.push({ number, deviceId, status: "sent" });

    } catch (err) {
      console.log("SEND ERROR:", err);
      results.push({ number, deviceId, status: "failed" });
    }

  }));

  // =========================
  // 🔥 CLEAN FILES (IMPORTANT)
  // =========================
  try {
    files.forEach(file => {
      const filePath = path.resolve(file.path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (err) {
    console.log("FILE DELETE ERROR:", err);
  }

  res.json({
    status: "done",
    total: numbers.length,
    results
  });

});

app.listen(5000, () => {
  console.log("🚀 Server running on http://localhost:5000");
});