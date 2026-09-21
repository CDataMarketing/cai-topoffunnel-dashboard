package com.cdata.hackathon.engine;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * GET /health -> {"status":"ok"} if the process is up.
 *
 * Pure liveness check — does NOT touch the JDBC connection, so it's safe for a
 * load balancer or uptime monitor to poll without ever triggering an OAuth/browser
 * prompt as a side effect. For auth state, use /auth/status; to trigger sign-in,
 * use /auth/login.
 */
public class HealthHandler implements HttpHandler {

  @Override
  public void handle(HttpExchange exchange) throws IOException {
    byte[] bytes = new JSONObject().put("status", "ok").toString().getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(200, bytes.length);
    try (var os = exchange.getResponseBody()) {
      os.write(bytes);
    }
  }
}
