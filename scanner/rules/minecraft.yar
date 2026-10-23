rule argonite_fractureiser_stage0
{
    meta:
        severity = "critical"
        description = "Fractureiser stage 0 loader (June 2023 Minecraft malware)"
    strings:
        $ip1 = "85.217.144.130" ascii wide
        $ip2 = "107.189.3.101" ascii wide
        $pkg = "dev/neko/nekoinjector" ascii
        $host = "files-8ie.pages.dev" ascii wide
    condition:
        any of them
}

rule argonite_discord_token_grabber
{
    meta:
        severity = "high"
        description = "Reads Discord token storage and posts to a webhook"
    strings:
        $leveldb = "Local Storage/leveldb" ascii nocase
        $leveldb2 = "Local Storage\\leveldb" ascii nocase
        $hook1 = "discord.com/api/webhooks" ascii nocase
        $hook2 = "discordapp.com/api/webhooks" ascii nocase
        $token = /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/ ascii
    condition:
        ($leveldb or $leveldb2) and ($hook1 or $hook2 or $token)
}

rule argonite_session_stealer
{
    meta:
        severity = "high"
        description = "Grabs the Minecraft session token and sends it somewhere"
    strings:
        $s1 = "func_148254_d" ascii
        $s2 = "getSessionToken" ascii
        $s3 = "getAccessToken" ascii
        $n1 = "java/net/HttpURLConnection" ascii
        $n2 = "java/net/http/HttpClient" ascii
        $w = "api/webhooks" ascii nocase
    condition:
        uint32be(0) == 0xCAFEBABE and any of ($s*) and any of ($n*) and $w
}
