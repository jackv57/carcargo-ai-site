const https = require('https');

exports.handler = async function(event, context) {
  // 1. 只允許 POST 請求
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // 2. 從 Netlify 的保險箱讀取 Make 網址 (我們剛剛在步驟 1 設定的那個)
  const makeUrl = process.env.MAKE_WEBHOOK_URL;

  if (!makeUrl) {
    return { statusCode: 500, body: "Server Error: Webhook URL not set." };
  }

  // 3. 準備轉傳資料
  const formData = event.body;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData)
      }
    };

    const req = https.request(makeUrl, options, (res) => {
      // 只要 Make 回傳 200~299 都算成功
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({
          statusCode: 200,
          body: "Success"
        });
      } else {
        resolve({
          statusCode: res.statusCode,
          body: "Error from Make"
        });
      }
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, body: "Internal Server Error" });
    });

    req.write(formData);
    req.end();
  });
};
