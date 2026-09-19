package com.woctordho.woximobile

import android.util.Log
import org.json.JSONObject

// Owner of the Wolfram Language interpreter (`libwoxi_jni.so`).
//
// The interpreter is not thread safe and keeps its session state between calls, so
// every request runs on one dedicated thread. The notebook UI stays responsive while
// an entry is being evaluated.
//
// Requests are queued with a priority instead of plain FIFO: a gesture frame on a
// plot must not wait behind a background re-sample, which can take hundreds of
// milliseconds. Interactive requests (view, retain, release) go first, then normal
// work (evaluation, Manipulate, reset), and only then background re-sampling. When an
// interactive request arrives, background work that has not started yet is dropped:
// the frontend asks for a re-sample again once the gesture has settled, so a queued
// one is already out of date.
object NativeEngine {

    private const val TAG = "Woxi"

    private external fun evaluateAll(input: String): String
    private external fun evaluateManipulate(body: String, bindingsJson: String): String
    private external fun plotRequest(request: String): String
    private external fun clear()
    private external fun setDarkMode(enabled: Boolean)

    // Kinds of work the frontend can ask for.
    const val KIND_TEXT = "text"
    const val KIND_RESET = "reset"
    const val KIND_MANIPULATE = "manipulate"

    // A queued unit of work, already bound to its callback.
    private class Task(val run: () -> Unit)

    private val lock = Object()
    private val interactive = ArrayDeque<Task>()
    private val normal = ArrayDeque<Task>()
    private val background = ArrayDeque<Task>()
    private var worker: Thread? = null
    private var loaded = false

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
            val result = try {
                ensureLoaded()
                applyDarkFlag()
                when (kind) {
                    KIND_RESET -> {
                        clear()
                        "[]"
                    }
                    KIND_MANIPULATE -> evaluateManipulate(body, bindings)
                    else -> evaluateAll(input)
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
    fun plotRequest(request: String, callback: (String) -> Unit) {
        val priority = priorityOf(request)
        submit(priority) {
            val reply = try {
                ensureLoaded()
                plotRequest(request)
            } catch (error: Throwable) {
                Log.w(TAG, "plot request failed", error)
                // Still a well-formed reply, so the frontend has one code path.
                val message = JSONObject()
                    .put("msg_type", "plot_error")
                    .put("status", "error")
                    .put("ename", "BridgeFailure")
                    .put("evalue", error.message ?: error.javaClass.simpleName)
                message.toString()
            }
            callback(reply)
        }
    }

    private fun priorityOf(request: String): Int {
        val type = try {
            JSONObject(request).optString("msg_type")
        } catch (error: Throwable) {
            ""
        }
        return when (type) {
            "plot_view", "plot_retain", "plot_release" -> INTERACTIVE
            "plot_refine", "plot_densify" -> BACKGROUND
            else -> NORMAL
        }
    }

    private fun submit(priority: Int, run: () -> Unit) {
        synchronized(lock) {
            startWorkerLocked()
            when (priority) {
                INTERACTIVE -> {
                    interactive.addLast(Task(run))
                    // A queued re-sample is stale as soon as the view moves on.
                    background.clear()
                }
                BACKGROUND -> background.addLast(Task(run))
                else -> normal.addLast(Task(run))
            }
            lock.notifyAll()
        }
    }

    private fun startWorkerLocked() {
        if (worker != null) return
        val thread = Thread({
            while (true) {
                val task = synchronized(lock) {
                    while (interactive.isEmpty() && normal.isEmpty() && background.isEmpty()) {
                        lock.wait()
                    }
                    when {
                        interactive.isNotEmpty() -> interactive.removeFirst()
                        normal.isNotEmpty() -> normal.removeFirst()
                        else -> background.removeFirst()
                    }
                }
                task.run()
            }
        }, "woxi-engine")
        thread.isDaemon = true
        thread.start()
        worker = thread
    }

    private fun ensureLoaded() {
        if (loaded) return
        System.loadLibrary("woxi_jni")
        loaded = true
    }

    // The notebook background decides how the typeset SVGs are coloured.
    private fun applyDarkFlag() {
        runCatching { setDarkMode(darkTypesetting) }
    }

    private fun errorJson(message: String): String {
        val item = JSONObject()
            .put("type", "error")
            .put("text", message)
        return "[$item]"
    }

    private const val INTERACTIVE = 0
    private const val BACKGROUND = 2
    private const val NORMAL = 1
}
