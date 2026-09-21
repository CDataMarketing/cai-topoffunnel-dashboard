package com.cdata.hackathon.engine;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * POST /auth/login -> {"authenticated": true} once connected.
 *
 * This is what a "Sign In" button's click handler should call. If no token is
 * cached yet, it opens the system browser for the CData Connect Cloud OAuth
 * consent screen and blocks until that completes (or fails) — a real person has
 * to click through it, so this call can take a while on first use. If a valid
 * token is already cached, it returns immediately. Design the UI to show a
 * "waiting for sign-in..." state rather than a plain spinner, and disable the
 * button while the request is in flight.
 */
public class AuthLoginHandler implements HttpHandler {

  private final ConnectEngine engine;

  public AuthLoginHandler(ConnectEngine engine) {
    this.engine = engine;
  }

  @Override
  public void handle(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      writeJson(exchange, 405, new JSONObject().put("error", "Use POST"));
      return;
    }
    try {
      engine.login();
      writeJson(exchange, 200, new JSONObject().put("authenticated", true));
    } catch (Exception e) {
      JSONObject error = new JSONObject()
          .put("authenticated", false)
          .put("error", e.getMessage() == null ? e.toString() : e.getMessage());
      writeJson(exchange, 500, error);
    }
  }

  private void writeJson(HttpExchange exchange, int status, JSONObject payload) throws IOException {
    byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, bytes.length);
    try (var os = exchange.getResponseBody()) {
      os.write(bytes);
    }
  }
}
