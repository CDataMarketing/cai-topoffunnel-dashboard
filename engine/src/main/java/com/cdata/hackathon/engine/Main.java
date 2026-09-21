package com.cdata.hackathon.engine;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

/**
 * Shared connectivity engine for the Marketing Cockpit hackathon. Wraps the CData
 * JDBC Driver for Connect behind a local HTTP API so any team's app — regardless of
 * language — can run SQL against Connect AI without touching JDBC or OAuth directly.
 *
 * Config via environment variables (all optional):
 *   ENGINE_PORT             default 8090
 *   OAUTH_SETTINGS_LOCATION default ./.oauth/oauthsettings.txt
 *   ENGINE_POOL_SIZE        default 5 — concurrent JDBC connections / request threads
 *
 * See engine/README.md for first-run OAuth login and calling conventions.
 */
public class Main {

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("ENGINE_PORT", "8090"));
    String oauthSettingsLocation = System.getenv()
        .getOrDefault("OAUTH_SETTINGS_LOCATION", "./.oauth/oauthsettings.txt");
    int poolSize = Integer.parseInt(System.getenv().getOrDefault("ENGINE_POOL_SIZE", "5"));

    ConnectEngine engine = new ConnectEngine(oauthSettingsLocation, poolSize);

    // Bound to loopback only: this is a local dev tool, not a network service.
    // Anyone who can run code on this machine can call it; nobody off-machine can.
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/health", new HealthHandler());
    server.createContext("/auth/status", new AuthStatusHandler(engine));
    server.createContext("/auth/login", new AuthLoginHandler(engine));
    server.createContext("/query", new QueryHandler(engine));
    // A thread pool, not setExecutor(null): the default runs every request
    // sequentially on one thread, so concurrent requests queue up and complete no
    // faster than doing them one at a time (measured — see engine/README.md).
    server.setExecutor(Executors.newFixedThreadPool(poolSize + 2));

    System.out.println("Connect engine listening on http://localhost:" + port);
    System.out.println("OAuth settings: " + oauthSettingsLocation);
    System.out.println("Connection pool size: " + poolSize);
    System.out.println("First request will open a browser for CData Connect Cloud login if no cached token exists.");

    server.start();
  }
}
