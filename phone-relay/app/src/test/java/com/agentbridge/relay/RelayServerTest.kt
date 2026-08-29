package com.agentbridge.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket

class RelayServerTest {
    @Test fun relayForwardsThroughServer() {
        val targetServer = ServerSocket(0)
        val targetThread = Thread {
            targetServer.accept().use { connection ->
                val buffer = ByteArray(4)
                connection.getInputStream().readFully(buffer)
                connection.getOutputStream().apply { write(buffer); flush() }
            }
        }.apply { start() }

        val server = RelayServer(RelayConfig("127.0.0.1", targetServer.localPort), listenPort = 0)
        server.start()
        Socket("127.0.0.1", server.actualPort()).use { client ->
            client.soTimeout = 2_000
            client.getOutputStream().apply { write("ping".toByteArray()); flush() }
            val response = ByteArray(4)
            client.getInputStream().readFully(response)
            assertArrayEquals("ping".toByteArray(), response)
        }

        server.stop()
        targetThread.join(2_000)
        targetServer.close()
    }

    @Test fun upstreamUnreachableClosesClient() {
        // 192.0.2.1 is TEST-NET-1 (RFC 5737), reserved and non-routable.
        val server = RelayServer(
            RelayConfig("192.0.2.1", 9),
            listenPort = 0,
            connectTimeoutMs = 800,
        )
        server.start()
        Socket("127.0.0.1", server.actualPort()).use { client ->
            client.soTimeout = 3_000
            assertEquals(-1, client.getInputStream().read())
        }
        server.stop()
    }

    private fun java.io.InputStream.readFully(target: ByteArray) {
        var offset = 0
        while (offset < target.size) {
            val count = read(target, offset, target.size - offset)
            check(count >= 0) { "Unexpected EOF" }
            offset += count
        }
    }
}
