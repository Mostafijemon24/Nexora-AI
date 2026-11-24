package ai.nexora.keystore

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

@InvokeArg
class SecretArgs {
  lateinit var name: String
  var value: String? = null
}

/**
 * Secrets (session token, license token, device registration) for the Android app.
 *
 * Each value is encrypted with AES-256-GCM under a key that is created inside the Android
 * Keystore and never leaves it, so the app's storage only ever holds ciphertext. The secret's
 * name is authenticated with it, so one stored value cannot be passed off as another.
 */
@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs: SharedPreferences by lazy {
    activity.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE)
  }

  private fun key(): SecretKey {
    val keystore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keystore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  private fun encrypt(name: String, value: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
    val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
  }

  private fun decrypt(name: String, stored: String): String {
    val parts = stored.split(":")
    require(parts.size == 2) { "Unreadable secret." }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
    cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
    return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
  }

  @Command
  fun set(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      val value = args.value ?: throw IllegalArgumentException("A value is required.")
      if (!prefs.edit().putString(args.name, encrypt(args.name, value)).commit()) {
        throw IllegalStateException("The secret could not be saved.")
      }
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Secure storage failed.")
    }
  }

  @Command
  fun get(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      val stored = prefs.getString(args.name, null)
      val value: String? = if (stored == null) null else try {
        decrypt(args.name, stored)
      } catch (ex: Exception) {
        // The Keystore key is gone (app data restored on another phone, or the lock screen was
        // reset): the value cannot be read by anyone any more, so it is treated as absent.
        prefs.edit().remove(args.name).commit()
        null
      }
      val result = JSObject()
      result.put("value", value ?: JSONObject.NULL)
      invoke.resolve(result)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Secure storage failed.")
    }
  }

  @Command
  fun delete(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecretArgs::class.java)
      prefs.edit().remove(args.name).commit()
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Secure storage failed.")
    }
  }

  /** The phone's model and Android version, shown in the license's device list. */
  @Command
  fun device(invoke: Invoke) {
    val maker = Build.MANUFACTURER?.trim().orEmpty()
    val model = Build.MODEL?.trim().orEmpty()
    val name = if (model.lowercase().startsWith(maker.lowercase())) model else "$maker $model".trim()
    val result = JSObject()
    result.put("name", name)
    result.put("os", "Android ${Build.VERSION.RELEASE}")
    invoke.resolve(result)
  }

  companion object {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "ai.nexora.app.secrets"
    private const val STORE = "nexora_secure_store"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}
