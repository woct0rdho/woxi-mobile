package com.woctordho.woximobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class AtomicNotebookFileTest {
    @get:Rule
    val folder = TemporaryFolder()

    // Windows does not support rename-over-an-existing-file. The production writer still
    // uses the atomic rename. This test seam only makes the replacement portable.
    private fun writeReplacing(
        file: File,
        bytes: ByteArray,
    ): Boolean =
        AtomicNotebookFile.write(file, bytes) { temp, base ->
            try {
                Files.move(temp.toPath(), base.toPath(), StandardCopyOption.REPLACE_EXISTING)
                true
            } catch (error: Exception) {
                false
            }
        }

    @Test
    fun writeAndReadReplaceTheWholeFileWithoutTemps() {
        val notebook = File(folder.root, "notebook.ipynb")
        val first = "{\"cells\":[]}".toByteArray()
        val second = "{\"cells\":[{\"cell_type\":\"code\"}]}".toByteArray()

        assertTrue(writeReplacing(notebook, first))
        assertArrayEquals(first, notebook.readBytes())
        assertFalse(File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX).exists())

        assertTrue(writeReplacing(notebook, second))
        assertArrayEquals(second, notebook.readBytes())
        assertFalse(File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX).exists())
    }

    @Test
    fun readDiscardsAnUncommittedTempWhenTheBaseExists() {
        val notebook = File(folder.root, "committed.ipynb")
        val committed = "{\"committed\":true}".toByteArray()
        notebook.writeBytes(committed)
        File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX).writeBytes("partial".toByteArray())

        assertArrayEquals(committed, AtomicNotebookFile.read(notebook))
        assertFalse(File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX).exists())
    }

    @Test
    fun readDoesNotPromoteAnUncommittedTempWithoutABase() {
        val notebook = File(folder.root, "missing.ipynb")
        val temp = File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX)
        temp.writeBytes("{\"partial\":true}".toByteArray())

        assertNull(AtomicNotebookFile.read(notebook))
        assertFalse(temp.exists())
        assertFalse(notebook.exists())
    }

    @Test
    fun deleteRemovesTheBaseAndTemp() {
        val notebook = File(folder.root, "delete.ipynb")
        val temp = File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX)
        notebook.writeBytes("base".toByteArray())
        temp.writeBytes("temp".toByteArray())

        assertTrue(AtomicNotebookFile.delete(notebook))
        assertFalse(notebook.exists())
        assertFalse(temp.exists())
    }

    @Test
    fun deleteOfAMissingNotebookIsIdempotent() {
        val notebook = File(folder.root, "missing.ipynb")

        assertTrue(AtomicNotebookFile.delete(notebook))
        assertFalse(notebook.exists())
    }

    @Test
    fun aFailedWriteKeepsThePreviousBaseFile() {
        val notebook = File(folder.root, "failed.ipynb")
        val previous = "{\"previous\":true}".toByteArray()
        assertTrue(AtomicNotebookFile.write(notebook, previous))

        // A directory at the temp path forces the write to fail after the base exists.
        val temp = File(notebook.path + AtomicNotebookFile.TEMP_SUFFIX)
        assertTrue(temp.mkdirs())

        assertFalse(AtomicNotebookFile.write(notebook, "{\"new\":true}".toByteArray()))
        assertArrayEquals(previous, notebook.readBytes())
    }

    @Test
    fun writeRefusesADirectoryAtTheDestinationAndCleansTheTemp() {
        val destination = File(folder.root, "directory.ipynb")
        assertTrue(destination.mkdirs())

        assertFalse(AtomicNotebookFile.write(destination, "content".toByteArray()))
        assertTrue(destination.isDirectory)
        assertFalse(File(destination.path + AtomicNotebookFile.TEMP_SUFFIX).exists())
    }

    @Test
    fun deleteRefusesADirectory() {
        val destination = File(folder.root, "directory.ipynb")
        assertTrue(destination.mkdirs())

        assertFalse(AtomicNotebookFile.delete(destination))
        assertTrue(destination.isDirectory)
    }
}
