package io.github.hermesandroid

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var web: WebView
    @Volatile private var loadedPort = 0
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    @Volatile private var sharedText: String = ""
    private var recognizer: SpeechRecognizer? = null
    private var pendingDictationLang: String? = null

    private val runtimeListener: (HermesRuntime.Snapshot) -> Unit = { s ->
        runOnUiThread {
            if (s.port > 0 && s.port != loadedPort) loadShell()
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#06071F"))
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString HermesAndroid/${BuildConfig.VERSION_NAME}"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                AssetServer.handle(this@MainActivity, request.url, loadedPort)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (AssetServer.isLocal(url, loadedPort)) return false
                openExternal(url)
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = params.createIntent().apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
                return try {
                    startActivityForResult(intent, REQUEST_FILES)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("HermesWeb", "${message.sourceId()}:${message.lineNumber()} ${message.message()}")
                return true
            }
        }

        web.setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
        web.addJavascriptInterface(Bridge(), "HermesAndroid")

        HermesRuntime.addListener(runtimeListener)
        if (Prefs.autoStart(this)) {
            HermesService.send(this, HermesService.ACTION_START)
        }
        handleIntent(intent)
        loadShell()
    }

    private fun loadShell() {
        val port = HermesRuntime.snapshot.port.takeIf { it > 0 } ?: Prefs.port(this)
        loadedPort = port
        web.loadUrl("http://127.0.0.1:$port${AssetServer.PREFIX}index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            if (text.isNotBlank()) {
                sharedText = text
                if (::web.isInitialized) web.evaluateJavascript("window.hermesShared && window.hermesShared()", null)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.hermesBack && window.hermesBack()) ? 'handled' : ''") { result ->
            if (result?.contains("handled") == true) return@evaluateJavascript
            if (web.canGoBack()) {
                web.goBack()
            } else {
                moveTaskToBack(true)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_SPEECH) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (resultCode == RESULT_OK && text.isNotBlank()) dictationEvent("final", text = text)
            dictationEvent("end")
            return
        }
        if (requestCode == REQUEST_FILES) {
            val callback = fileCallback
            fileCallback = null
            if (callback == null) return
            var result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            val clip = data?.clipData
            if (resultCode == RESULT_OK && clip != null && clip.itemCount > 1) {
                result = Array(clip.itemCount) { clip.getItemAt(it).uri }
            }
            callback.onReceiveValue(result)
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.hermesResume && window.hermesResume()", null)
    }

    override fun onPause() {
        stopDictation(cancel = true)
        web.onPause()
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_AUDIO) return
        val lang = pendingDictationLang ?: "fr-FR"
        pendingDictationLang = null
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startDictation(lang)
        } else {
            dictationEvent("error", message = "Autorise le micro dans les réglages d’Android pour dicter.")
        }
    }

    // ── Dictée vocale : SpeechRecognizer (résultats partiels) ou, à défaut, l'écran de Google ──

    private fun dictationEvent(type: String, text: String? = null, message: String? = null) {
        val json = JSONObject().put("type", type)
        if (text != null) json.put("text", text)
        if (message != null) json.put("message", message)
        runOnUiThread {
            if (::web.isInitialized) web.evaluateJavascript("window.hermesDictation && window.hermesDictation($json)", null)
        }
    }

    private fun speechIntent(lang: String): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Parle, Hermes t’écoute")

    private fun startDictation(lang: String) {
        stopDictation(cancel = true)
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            // Pas de service de reconnaissance intégré : on tente l'écran de dictée du système.
            try {
                dictationEvent("start")
                startActivityForResult(speechIntent(lang), REQUEST_SPEECH)
            } catch (_: ActivityNotFoundException) {
                dictationEvent("error", message = "Aucun service de dictée sur ce téléphone (installe ou active Google).")
            }
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingDictationLang = lang
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        val sr = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = sr
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = dictationEvent("start")
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) dictationEvent("partial", text = text)
            }

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isNotBlank()) dictationEvent("final", text = text)
                dictationEvent("end")
                releaseRecognizer(sr)
            }

            override fun onError(error: Int) {
                val message = when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH -> "Je n’ai rien compris, réessaie."
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Aucune parole détectée."
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Dictée : réseau indisponible."
                    SpeechRecognizer.ERROR_AUDIO -> "Le micro n’est pas disponible."
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Autorise le micro dans les réglages d’Android pour dicter."
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "La dictée est déjà utilisée par une autre app."
                    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                        "Le français n’est pas disponible pour la dictée sur ce téléphone."
                    SpeechRecognizer.ERROR_CLIENT -> null // arrêt demandé par l'utilisateur
                    else -> "La dictée s’est arrêtée (code $error)."
                }
                if (message != null) dictationEvent("error", message = message) else dictationEvent("end")
                releaseRecognizer(sr)
            }
        })
        try {
            sr.startListening(speechIntent(lang))
        } catch (e: Exception) {
            releaseRecognizer(sr)
            dictationEvent("error", message = "Impossible de lancer la dictée.")
        }
    }

    private fun releaseRecognizer(sr: SpeechRecognizer) {
        if (recognizer === sr) recognizer = null
        try { sr.destroy() } catch (_: Exception) { }
    }

    /** Arrête l'écoute : les mots déjà entendus arrivent dans onResults (sauf annulation). */
    private fun stopDictation(cancel: Boolean) {
        val sr = recognizer ?: return
        if (cancel) {
            try { sr.cancel() } catch (_: Exception) { }
            releaseRecognizer(sr)
            dictationEvent("end")
        } else {
            try { sr.stopListening() } catch (_: Exception) { releaseRecognizer(sr); dictationEvent("end") }
        }
    }

    override fun onDestroy() {
        recognizer?.let { releaseRecognizer(it) }
        HermesRuntime.removeListener(runtimeListener)
        web.destroy()
        super.onDestroy()
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "Aucune application ne peut ouvrir ce lien", Toast.LENGTH_SHORT).show()
        }
    }

    /** Controls for the shell page. Nothing here reveals secrets (see AssetServer). */
    inner class Bridge {
        @JavascriptInterface
        fun start() = HermesService.send(this@MainActivity, HermesService.ACTION_START)

        @JavascriptInterface
        fun stop() = HermesService.send(this@MainActivity, HermesService.ACTION_STOP)

        @JavascriptInterface
        fun restart() = HermesService.send(this@MainActivity, HermesService.ACTION_RESTART)

        @JavascriptInterface
        fun keepAwake(): Boolean = Prefs.keepAwake(this@MainActivity)

        @JavascriptInterface
        fun setKeepAwake(value: Boolean) = Prefs.setKeepAwake(this@MainActivity, value)

        @JavascriptInterface
        fun autoStart(): Boolean = Prefs.autoStart(this@MainActivity)

        @JavascriptInterface
        fun setAutoStart(value: Boolean) = Prefs.setAutoStart(this@MainActivity, value)

        @JavascriptInterface
        fun batteryOptimized(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return !pm.isIgnoringBatteryOptimizations(packageName)
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestBatteryExemption() {
            runOnUiThread {
                try {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
                    )
                } catch (_: ActivityNotFoundException) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
        }

        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            val uri = Uri.parse(url)
            if (uri.scheme == "http" || uri.scheme == "https") runOnUiThread { this@MainActivity.openExternal(uri) }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Hermes", text))
                Toast.makeText(this@MainActivity, "Copié", Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun shareText(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(send, "Partager"))
            }
        }

        @JavascriptInterface
        fun takeSharedText(): String {
            val text = sharedText
            sharedText = ""
            return text
        }

        @JavascriptInterface
        fun toast(text: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, text, Toast.LENGTH_SHORT).show() }
        }

        /** Fichiers de l'agent modifiables depuis l'app (âme et mémoire), et seulement ceux-là. */
        private fun agentFile(name: String): java.io.File? {
            val allowed = setOf("SOUL.md", "memories/MEMORY.md", "memories/USER.md")
            if (name !in allowed) return null
            return java.io.File(RuntimeEnv.hermesHome(this@MainActivity), name)
        }

        @JavascriptInterface
        fun readAgentFile(name: String): String {
            val f = agentFile(name) ?: return ""
            return try { if (f.isFile) f.readText(Charsets.UTF_8) else "" } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun writeAgentFile(name: String, content: String): Boolean {
            val f = agentFile(name) ?: return false
            return try {
                f.parentFile?.mkdirs()
                val tmp = java.io.File(f.parentFile, f.name + ".tmp")
                tmp.writeText(content, Charsets.UTF_8)
                if (!tmp.renameTo(f)) { f.writeText(content, Charsets.UTF_8); tmp.delete() }
                true
            } catch (e: Exception) { false }
        }

        /** Dictée vocale (fr-FR par défaut) ; les résultats arrivent via window.hermesDictation. */
        @JavascriptInterface
        fun startDictation(lang: String) {
            val tag = lang.takeIf { it.matches(Regex("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*")) } ?: "fr-FR"
            runOnUiThread { this@MainActivity.startDictation(tag) }
        }

        @JavascriptInterface
        fun stopDictation() {
            runOnUiThread { this@MainActivity.stopDictation(cancel = false) }
        }

        @JavascriptInterface
        fun deviceInfo(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}"
    }

    companion object {
        private const val REQUEST_FILES = 7001
        private const val REQUEST_SPEECH = 7002
        private const val REQUEST_AUDIO = 7003
    }
}
