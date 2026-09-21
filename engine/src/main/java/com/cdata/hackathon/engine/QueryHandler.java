package com.cdata.hackathon.engine;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** POST /query  { "sql": "SELECT ... LIMIT 100" }  ->  { columns, rows, rowCount } */
public class QueryHandler implements HttpHandler {

  private final ConnectEngine engine;

  public QueryHandler(ConnectEngine engine) {
    this.engine = engine;
  }

  @Override
  public void handle(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      writeJson(exchange, 405, new JSONObject().put("error", "Use POST"));
      return;
    }

    String body;
    try (InputStream is = exchange.getRequestBody()) {
      body = new String(is.readAllBytes(), StandardCharsets.UTF_8);
    }

    String sql;
    try {
      sql = new JSONObject(body).getString("sql");
    } catch (Exception e) {
      writeJson(exchange, 400, new JSONObject().put("error", "Request body must be JSON: {\"sql\": \"...\"}"));
      return;
    }

    if (sql == null || sql.isBlank()) {
      writeJson(exchange, 400, new JSONObject().put("error", "\"sql\" must not be blank"));
      return;
    }

    try {
      ConnectEngine.QueryResult result = engine.execute(sql);
      JSONObject response = new JSONObject();
      if (result.updateCount != null) {
        response.put("updateCount", result.updateCount);
      } else {
        List<Map<String, Object>> rows = ConnectEngine.toListOfMaps(result);
        response.put("columns", new JSONArray(result.columns));
        response.put("rows", new JSONArray(rows));
        response.put("rowCount", result.rowCount);
      }
      writeJson(exchange, 200, response);
    } catch (Exception e) {
      JSONObject error = new JSONObject()
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
