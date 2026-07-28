package com.rokid.renewcxrlsample.utils

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import java.io.File

/**
 * Validates storage permissions before reading APK files for [appUploadAndInstall].
 * App-specific paths do not require MANAGE_EXTERNAL_STORAGE; public paths do.
 */
object ApkInstallAccess {

    fun hasStoragePermissionForPublicApk(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return true
        }
        return context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun isPublicStoragePath(file: File): Boolean {
        val path = file.absolutePath
        // App-specific external files dir is not public storage
        if (path.contains("/Android/data/")) return false
        val publicRoot = Environment.getExternalStorageDirectory().absolutePath
        return path.startsWith("/sdcard") || path.startsWith(publicRoot)
    }

    fun isReadableApkFile(context: Context, file: File): Boolean {
        if (!file.exists() || !file.isFile) return false
        if (!isPublicStoragePath(file)) return true  // app-private dirs are always readable
        // Public storage requires MANAGE_EXTERNAL_STORAGE
        if (file.canRead()) return true
        return hasStoragePermissionForPublicApk(context)
    }

    fun hasApkOnPublicPathWithoutPermission(context: Context, candidates: List<File>): Boolean {
        val publicCandidates = listOfNotNull(
            File("/sdcard/DCIM/Rokid/cxrL.apk"),
            Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DCIM + File.separator + "Rokid"
            )?.resolve("cxrL.apk")
        )
        return publicCandidates.any { it.exists() && it.isFile && isPublicStoragePath(it) } &&
            !hasStoragePermissionForPublicApk(context) &&
            candidates.isEmpty()
    }
}
