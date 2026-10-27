package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HistoryEpochTest {
    private fun ready() = JSONObject().put("schema_version", "paios.central.text-envelope.v1")
        .put("session_id", "synthetic-session").put("operation", "ready")

    @Test fun epochTravelsOnlyInsideTheBoundReadyEnvelope() {
        val epoch = "a".repeat(32)
        val packet = ready().put("history_epoch", epoch)
        assertEquals(epoch, formalPacket(packet.toString().toByteArray(), "synthetic-session").getString("history_epoch"))
        assertFalse(formalPacket(ready().toString().toByteArray(), "synthetic-session").has("history_epoch"))
        for (invalid in listOf(ready().put("history_epoch", "bad"), ready().put("delete_history", true),
            ready().put("history_epoch", JSONObject.NULL), ready().put("session_id", "another-session"))) {
            try { formalPacket(invalid.toString().toByteArray(), "synthetic-session"); fail("invalid ready accepted") }
            catch (expected: IllegalArgumentException) { }
            catch (expected: org.json.JSONException) { }
        }
    }
}
