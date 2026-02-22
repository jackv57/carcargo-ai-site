exports.handler = async function(event, context) {
  // 不管是 GET 還是 POST，全部通通接受！
  // 也不讀取環境變數，單純測試連線。
  
  console.log("收到請求！方法是：", event.httpMethod); // 這會寫入 Netlify Log

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      status: "Success",
      message: "恭喜！你的網頁成功連到後端了！",
      method: event.httpMethod, // 告訴我們它是用什麼方法連進來的
      hasBody: !!event.body
    })
  };
};
