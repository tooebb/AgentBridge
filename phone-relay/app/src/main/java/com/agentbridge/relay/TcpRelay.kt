package com.agentbridge.relay

import java.io.InputStream
import java.io.OutputStream
import java.net.Socket

class TcpRelay {
    fun relay(client: Socket, upstream: Socket) {
        val clientToUpstream = Thread {
            pump(client.getInputStream(), upstream.getOutputStream())
            runCatching { upstream.shutdownOutput() }
        }
        val upstreamToClient = Thread {
            pump(upstream.getInputStream(), client.getOutputStream())
            runCatching { client.shutdownOutput() }
        }
        clientToUpstream.start()
        upstreamToClient.start()
        try {
            clientToUpstream.join()
            upstreamToClient.join()
        } finally {
            runCatching { client.close() }
            runCatching { upstream.close() }
        }
    }

    private fun pump(input: InputStream, output: OutputStream) {
        try {
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
                output.flush()
            }
        } catch (_: Exception) {
            // Closing either socket is the normal mechanism used to stop both pumps.
        }
    }
}
