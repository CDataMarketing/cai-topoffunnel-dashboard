package com.cdata.hackathon.engine;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thin wrapper around the CData JDBC Driver for Connect. Authenticates via OAuth
 * (InitiateOAuth=GETANDREFRESH) so no username/PAT is ever stored — the first
 * connection opens a browser for interactive login, then the driver persists and
 * silently refreshes the token at OAuthSettingsLocation.
 *
 * Maintains a small pool of independent JDBC Connections rather than one shared
 * Connection. A single Connection isn't safe for concurrent use by multiple
 * threads — sharing one across concurrent requests either serializes everything
 * behind it or corrupts results. Each request borrows its own Connection for the
 * duration of one query and returns it afterward.
 */
public class ConnectEngine {

  private final String jdbcUrl;
  private final int poolSize;
  private final LinkedBlockingQueue<Connection> pool = new LinkedBlockingQueue<>();
  private final AtomicInteger created = new AtomicInteger(0);
  private final AtomicBoolean authenticated = new AtomicBoolean(false);
  private final Object createLock = new Object();

  public ConnectEngine(String oauthSettingsLocation, int poolSize) {
    this.jdbcUrl = "jdbc:connect:AuthScheme=OAuth;InitiateOAuth=GETANDREFRESH;"
        + "OAuthSettingsLocation=" + oauthSettingsLocation;
    this.poolSize = poolSize;
  }

  /**
   * Explicit sign-in. Opens a browser for OAuth consent if no token is cached yet
   * (blocks until that completes or fails); returns immediately if already signed
   * in. On success, pre-warms the rest of the connection pool using the
   * now-cached token — those connections are non-interactive.
   */
  public void login() throws Exception {
    if (authenticated.get()) {
      return;
    }
    synchronized (createLock) {
      if (authenticated.get()) {
        return;
      }
      Connection first = DriverManager.getConnection(jdbcUrl);
      created.incrementAndGet();
      pool.offer(first);
      authenticated.set(true);
    }
    for (int i = 1; i < poolSize; i++) {
      try {
        pool.offer(DriverManager.getConnection(jdbcUrl));
        created.incrementAndGet();
      } catch (Exception e) {
        break; // Pool just runs smaller; borrowConnection() creates more on demand.
      }
    }
  }

  /** Non-triggering check — never attempts a connection as a side effect. */
  public boolean isAuthenticated() {
    return authenticated.get();
  }

  private Connection borrowConnection() throws Exception {
    if (!authenticated.get()) {
      throw new IllegalStateException("Not signed in — call POST /auth/login first");
    }
    Connection c = pool.poll();
    if (c != null && !c.isClosed()) {
      return c;
    }
    if (c != null) {
      created.decrementAndGet(); // discard the closed one
    }
    synchronized (createLock) {
      if (created.get() < poolSize) {
        Connection nc = DriverManager.getConnection(jdbcUrl);
        created.incrementAndGet();
        return nc;
      }
    }
    return pool.take(); // at capacity — wait for one to free up
  }

  private void returnConnection(Connection c) {
    if (c == null) {
      return;
    }
    try {
      if (!c.isClosed()) {
        pool.offer(c);
        return;
      }
    } catch (Exception ignored) {
      // fall through to treat as discarded
    }
    created.decrementAndGet();
  }

  public static final class QueryResult {
    public final List<String> columns;
    public final List<List<Object>> rows;
    public final int rowCount;
    public final Integer updateCount;

    QueryResult(List<String> columns, List<List<Object>> rows, Integer updateCount) {
      this.columns = columns;
      this.rows = rows;
      this.rowCount = rows.size();
      this.updateCount = updateCount;
    }
  }

  /**
   * Executes a single SQL statement on its own borrowed connection. SELECT
   * statements return rows; INSERT/UPDATE/DELETE return an affected-row count.
   * Callers are responsible for following the write-back conventions in the root
   * CLAUDE.md (HACKATHON prefixes, write logging) — this layer is plumbing, not
   * policy enforcement.
   */
  public QueryResult execute(String sql) throws Exception {
    Connection conn = borrowConnection();
    try (Statement stmt = conn.createStatement()) {
      boolean isResultSet = stmt.execute(sql);
      if (isResultSet) {
        try (ResultSet rs = stmt.getResultSet()) {
          return readResultSet(rs);
        }
      } else {
        int updateCount = stmt.getUpdateCount();
        return new QueryResult(List.of(), List.of(), updateCount);
      }
    } finally {
      returnConnection(conn);
    }
  }

  private QueryResult readResultSet(ResultSet rs) throws Exception {
    ResultSetMetaData meta = rs.getMetaData();
    int colCount = meta.getColumnCount();
    List<String> columns = new ArrayList<>(colCount);
    for (int i = 1; i <= colCount; i++) {
      columns.add(meta.getColumnLabel(i));
    }

    List<List<Object>> rows = new ArrayList<>();
    while (rs.next()) {
      List<Object> row = new ArrayList<>(colCount);
      for (int i = 1; i <= colCount; i++) {
        row.add(rs.getObject(i));
      }
      rows.add(row);
    }
    return new QueryResult(columns, rows, null);
  }

  public static List<Map<String, Object>> toListOfMaps(QueryResult result) {
    List<Map<String, Object>> out = new ArrayList<>(result.rows.size());
    for (List<Object> row : result.rows) {
      Map<String, Object> map = new LinkedHashMap<>();
      for (int i = 0; i < result.columns.size(); i++) {
        map.put(result.columns.get(i), row.get(i));
      }
      out.add(map);
    }
    return out;
  }
}
