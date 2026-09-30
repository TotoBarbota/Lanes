import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

/** Gateway service: the browser's entry point. Answers with its message and whatever orders says. */
public class App {
    static final String MESSAGE = "Welcome to the demo shop";

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(env("PORT", "3380"));
        String downstream = env("DOWNSTREAM", "");
        HttpClient client = HttpClient.newHttpClient();
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/health", ex -> reply(ex, "{\"status\":\"UP\"}"));
        server.createContext("/", ex -> {
            String calls = "null";
            if (!downstream.isEmpty()) {
                try {
                    calls = client.send(HttpRequest.newBuilder(URI.create(downstream)).build(), HttpResponse.BodyHandlers.ofString()).body();
                } catch (Exception e) {
                    calls = "{\"error\":\"" + e.getClass().getSimpleName() + "\"}";
                }
            }
            reply(ex, "{\"service\":\"gateway\",\"lane\":\"" + env("LANES_LANE", "") + "\",\"message\":\"" + MESSAGE + "\",\"calls\":" + calls + "}");
        });
        server.start();
        System.out.println("gateway listening on " + port);
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
