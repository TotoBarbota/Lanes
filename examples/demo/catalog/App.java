import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/** Catalog service: the end of the call chain. */
public class App {
    static final String MESSAGE = "Price: 42.00 EUR";

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(env("PORT", "3382"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/health", ex -> reply(ex, "{\"status\":\"UP\"}"));
        server.createContext("/", ex ->
            reply(ex, "{\"service\":\"catalog\",\"lane\":\"" + env("LANES_LANE", "") + "\",\"message\":\"" + MESSAGE + "\",\"calls\":null}"));
        server.start();
        System.out.println("catalog listening on " + port);
    }

    static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isEmpty() ? fallback : v;
    }

    static void reply(HttpExchange ex, String json) throws java.io.IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(200, body.length);
        ex.getResponseBody().write(body);
        ex.close();
    }
}
