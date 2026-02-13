exports.handler = async (event) => {
  const method =
    event.httpMethod ||
    event.requestContext?.http?.method;

  if (method !== "POST") {
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

    if (response.ok) {
      return {
        statusCode: 200,
        body: "Success",
      };
    } else {
      return {
        statusCode: 500,
        body: "Make error",
      };
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: "Server error",
    };
  }
};
