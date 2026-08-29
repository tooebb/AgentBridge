package com.agentbridge.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket

class TcpRelayTest {
    @Test fun relayForwardsBytesInBothDirections() {
        val upstreamServer = ServerSocket(0)
        val upstreamGot = ByteArrayOutputStream()
        val upstreamThread = Thread {
            upstreamServer.accept().use { connection ->
                val request = ByteArray(5)
                connection.getInputStream().readFully(request)
                upstreamGot.write(request)
                connection.getOutputStream().apply {
                    write("world".toByteArray())
                    flush()
                }
            }
        }.apply { start() }

        val relayServer = ServerSocket(0)
        val relayThread = Thread {
            relayServer.accept().use { client ->
                Socket("127.0.0.1", upstreamServer.localPort).use { upstream ->
                    TcpRelay().relay(client, upstream)
                }
            }
        }.apply { start() }

        Socket("127.0.0.1", relayServer.localPort).use { client ->
            client.soTimeout = 2_000
            client.getOutputStream().apply { write("hello".toByteArray()); flush() }
            val response = ByteArray(5)
            client.getInputStream().readFully(response)
            assertArrayEquals("world".toByteArray(), response)
        }

        relayThread.join(2_000)
        upstreamThread.join(2_000)
        assertFalse(relayThread.isAlive)
        assertFalse(upstreamThread.isAlive)
        assertArrayEquals("hello".toByteArray(), upstreamGot.toByteArray())
        relayServer.close()
        upstreamServer.close()
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
