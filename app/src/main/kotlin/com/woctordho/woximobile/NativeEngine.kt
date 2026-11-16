package com.woctordho.woximobile

import android.util.Log
import org.json.JSONObject
import java.util.concurrent.PriorityBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

// Owner of the Wolfram Language interpreter (`libwoxi_jni.so`).
//
// The interpreter is not thread safe and keeps its session state between calls, so
// every request runs on one dedicated thread. The notebook UI stays responsive while
// an entry is being evaluated.
//
// Requests are queued with a priority instead of plain FIFO: a gesture frame on a
// plot must not wait behind a background re-sample, which can take hundreds of
// milliseconds. Interactive requests (view, release) go first, then normal
// work (evaluation, Manipulate, reset), and only then background re-sampling. Nothing
// queued is ever dropped: a request whose callback never runs would leave its caller
// waiting forever, so a stale re-sample runs in its turn instead.
object NativeEngine {
    private const val TAG = "Woxi"

    private external fun evaluateAll(input: String): String

    private external fun evaluateManipulate(
        body: String,
        bindingsJson: String,
    ): String

    private external fun plotRequest(request: String): String

    private external fun queryRequest(request: String): String

    private external fun clear()

    private external fun setDarkMode(enabled: Boolean)

    // Kinds of work the frontend can ask for.
    const val KIND_RESET = "reset"
    const val KIND_MANIPULATE = "manipulate"

    // A queued unit of work, ordered by its priority and then by arrival. `PriorityBlockingQueue`
    // is the lock and the wait: the worker blocks in `take()` and a submission wakes it, so
    // there is no monitor object, no hand-written wait loop and nothing to notify (Kotlin has no
    // `wait`/`notify` on `Any` for exactly this reason - the library primitive is the answer).
    // `sequence` is the tiebreaker: the queue is a heap, so without it two requests of the same
    // priority could run out of order.
    private class Task(
        val priority: Int,
        val sequence: Long,
        val run: () -> Unit,
    ) : Comparable<Task> {
        override fun compareTo(other: Task): Int =
            if (priority != other.priority) {
                priority.compareTo(other.priority)
            } else {
                sequence.compareTo(other.sequence)
            }
    }

    private val queue = PriorityBlockingQueue<Task>()
    private val sequence = AtomicLong()
    private var loaded = false

    init {
        // One daemon thread for the life of the process, because the interpreter is stateful and
        // not thread safe. It costs a blocked thread, and it removes the lazy-start handshake the
        // monitor needed.
        thread(start = true, isDaemon = true, name = "woxi-engine") {
            while (true) {
                val task =
                    try {
                        queue.take()
                    } catch (interrupted: InterruptedException) {
                        // Nothing interrupts this thread in normal use, but an interrupt must not
                        // end the only thread that can reach the interpreter.
                        continue
                    }
                try {
                    task.run()
                } catch (error: Throwable) {
                    // A task failing must not take the engine thread down with it.
                    Log.w(TAG, "engine task failed", error)
                }
            }
        }
    }

    // Whether typeset output should be drawn for a dark background.
    @Volatile
    private var darkTypesetting = true

    // Switches the interpreter's typesetting between light and dark output.
    fun setDark(enabled: Boolean) {
        darkTypesetting = enabled
        submit(NORMAL) {
            runCatching {
                ensureLoaded()
                applyDarkFlag()
            }
        }
    }

    // Runs [input] through the interpreter and hands the JSON result to [callback] on
    // the engine thread. Never throws: failures come back as an `error` item.
    fun request(
        kind: String,
        input: String,
        body: String,
        bindings: String,
        callback: (String) -> Unit,
    ) {
        submit(NORMAL) {
            val result =
                try {
                    ensureLoaded()
                    applyDarkFlag()
                    when (kind) {
                        KIND_RESET -> {
                            clear()
                            "[]"
                        }

                        KIND_MANIPULATE -> {
                            evaluateManipulate(body, bindings)
                        }

                        else -> {
                            evaluateAll(input)
                        }
                    }
                } catch (error: Throwable) {
                    Log.w(TAG, "engine request failed", error)
                    errorJson(error.message ?: error.javaClass.simpleName)
                }
            callback(result)
        }
    }

    // Runs one plot-interaction message (see the JNI header for the shape) and hands
    // the reply JSON to [callback].
    fun plotRequest(
        request: String,
        callback: (String) -> Unit,
    ) {
        val priority = priorityOf(request)
        submit(priority) {
            val reply =
                try {
                    ensureLoaded()
                    plotRequest(request)
                } catch (error: Throwable) {
                    Log.w(TAG, "plot request failed", error)
                    // Still a well-formed reply, so the frontend has one code path.
                    val message =
                        JSONObject()
                            .put("msg_type", "plot_error")
                            .put("status", "error")
                            .put("ename", "BridgeFailure")
                            .put("evalue", error.message ?: error.javaClass.simpleName)
                    message.toString()
                }
            callback(reply)
        }
    }

    // Answers one typing-help message: completion, inspection, completeness, diagnostics,
    // prototypes, definitions, formatting or the catalog (see the JNI header). Replies
    // share the plot envelope, so the frontend has one code path for both.
    //
    // Most run at NORMAL priority, not INTERACTIVE: interactive work overtakes queued
    // background re-sampling, and a completion on every keystroke must not make a plot
    // wait behind the typing. The catalog is a one-off BACKGROUND request.
    fun query(
        request: String,
        callback: (String) -> Unit,
    ) {
        val priority = queryPriorityOf(request)
        submit(priority) {
            val reply =
                try {
                    ensureLoaded()
                    queryRequest(request)
                } catch (error: Throwable) {
                    Log.w(TAG, "query failed", error)
                    JSONObject()
                        .put("msg_type", "query_error")
                        .put("status", "error")
                        .put("ename", "BridgeFailure")
                        .put("evalue", error.message ?: error.javaClass.simpleName)
                        .toString()
                }
            callback(reply)
        }
    }

    private fun queryPriorityOf(request: String): Int =
        when (messageType(request)) {
            // One-off: the category counts for the suggestion sheet.
            "catalog_request" -> BACKGROUND

            else -> NORMAL
        }

    private fun priorityOf(request: String): Int =
        when (messageType(request)) {
            "plot_view", "plot_release" -> INTERACTIVE
            "plot_refine", "plot_densify" -> BACKGROUND
            else -> NORMAL
        }

    private fun messageType(request: String): String =
        try {
            JSONObject(request).optString("msg_type")
        } catch (error: Throwable) {
            ""
        }

    private fun submit(
        priority: Int,
        run: () -> Unit,
    ) {
        // Unbounded and never blocks. It wakes the worker, and the comparator puts the request
        // where its priority says it belongs.
        queue.add(Task(priority, sequence.incrementAndGet(), run))
    }

    private fun ensureLoaded() {
        if (loaded) return
        System.loadLibrary("woxi_jni")
        loaded = true
    }

    // The notebook background decides how the typeset SVGs are colored.
    private fun applyDarkFlag() {
        runCatching { setDarkMode(darkTypesetting) }
    }

    private fun errorJson(message: String): String {
        val item =
            JSONObject()
                .put("type", "error")
                .put("text", message)
        return "[$item]"
    }

    private const val INTERACTIVE = 0
    private const val BACKGROUND = 2
    private const val NORMAL = 1
}
