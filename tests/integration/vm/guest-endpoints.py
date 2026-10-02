"""Disposable guest services for HTTP, TCP, and UDP reachability probes."""
import http.server
import socketserver
import threading


class HttpHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"terrarium-vm-integration\n")


class TcpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.sendall(b"terrarium-vm-tcp:" + self.request.recv(512))


class UdpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        sock.sendto(b"terrarium-vm-udp:" + data, self.client_address)


servers = [
    http.server.ThreadingHTTPServer(("0.0.0.0", 8080), HttpHandler),
    socketserver.ThreadingTCPServer(("0.0.0.0", 9001), TcpHandler),
    socketserver.ThreadingUDPServer(("0.0.0.0", 9002), UdpHandler),
]
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
