package com.cdata.hackathon.engine;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * GET /auth/status -> {"authenticated": true|false}
 *
 * Non-triggering: reports current state only, never attempts a connection. A UI
 * should poll this on page load to decide whether to show "Sign In" or
 * "Signed in" — polling /auth/login instead would risk re-triggering the OAuth
 * flow.
 */
public class AuthStatusHandler implements HttpHandler {

  private final ConnectEngine engine;

  public AuthStatusHandler(ConnectEngine engine) {
    this.engine = engine;
  }

  @Override
  public void handle(HttpExchange exchange) throws IOException {
    byte[] bytes = new JSONObject()
        .put("authenticated", engine.isAuthenticated())
        .toString().getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(200, bytes.length);
    try (var os = exchange.getResponseBody()) {
      os.write(bytes);
    }
  }
}
