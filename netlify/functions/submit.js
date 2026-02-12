const https = require('https');

exports.handler = async function(event, context) {
  // 1. 只允許 POST 請求
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // 2. 從 Netlify 的保險箱讀取真正的 Make.com 網址
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
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({
          statusCode: 200,
          // 重新導向回你的網站首頁，並帶上 success 參數
          headers: { Location: '/?status=success' }, 
          body: "Success"
        });
      } else {
        resolve({
          statusCode: res.statusCode,
          body: "Error connecting to Make"
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
