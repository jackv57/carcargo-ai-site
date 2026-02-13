exports.handler = async (event) => {
  console.log("Incoming event:", event);

  if (event.rawMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  const makeUrl = process.env.MAKE_WEBHOOK_URL;

  if (!makeUrl) {
    return {
      statusCode: 500,
      body: "Webhook URL not set",
    };
  }

  try {
    const response = await fetch(makeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: event.body,
    });

    return {
      statusCode: 200,
      body: "Success",
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: "Server error",
    };
  }
};
