#!/usr/bin/env python3
"""Méthode B (bac à sable, sans outils Android) pour l'APK nanoMuse Hermes :
- SHA-256 du fichier recalculé (hashlib) ;
- certificat de signature lu directement dans l'APK Signing Block (schéma v2 0x7109871a, sinon v3 0xf05368c0),
  SHA-256 du certificat DER ; puis le DER est aussi passé à `openssl x509` (3e lecture) ;
- applicationId / versionCode / versionName : AndroidManifest.xml binaire (AXML) décodé ici.
Usage : python3 verif_apk.py <apk> [sha256_attendu] [cert_attendu]
"""
import hashlib, struct, sys, zipfile, subprocess

def sha256_fichier(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def bloc_signature(data):
    # fin du répertoire central (EOCD)
    i = data.rfind(b'PK\x05\x06')
    if i < 0: raise ValueError('EOCD absent')
    cd_off = struct.unpack('<I', data[i+16:i+20])[0]
    if data[cd_off-16:cd_off] != b'APK Sig Block 42': raise ValueError('APK Signing Block absent')
    taille = struct.unpack('<Q', data[cd_off-24:cd_off-16])[0]
    debut = cd_off - taille - 8
    paires = data[debut+8:cd_off-24]
    out = {}; k = 0
    while k < len(paires):
        n = struct.unpack('<Q', paires[k:k+8])[0]; ident = struct.unpack('<I', paires[k+8:k+12])[0]
        out[ident] = paires[k+12:k+8+n]; k += 8 + n
    return out

def lp(b, o):  # bloc préfixé par sa longueur (uint32)
    n = struct.unpack('<I', b[o:o+4])[0]; return b[o+4:o+4+n], o+4+n

def certificats(v):
    signers, _ = lp(v, 0); certs = []
    o = 0
    while o < len(signers):
        signer, o = lp(signers, o)
        signed, _ = lp(signer, 0)
        _digests, p = lp(signed, 0)
        cl, p = lp(signed, p)
        q = 0
        while q < len(cl):
            c, q = lp(cl, q); certs.append(c)
    return certs

# ---- AXML minimal ----
def axml_manifest(b):
    def u16(o): return struct.unpack('<H', b[o:o+2])[0]
    def u32(o): return struct.unpack('<I', b[o:o+4])[0]
    o = 8; chaines = []; res = {}
    while o < len(b):
        typ, hdr, size = u16(o), u16(o+2), u32(o+4)
        if typ == 0x0001:  # string pool
            n = u32(o+8); flags = u32(o+16); sstart = u32(o+20); utf8 = flags & 0x100
            for i in range(n):
                so = o + sstart + u32(o+hdr+4*i)
                if utf8:
                    l = b[so]; so += 2 if l & 0x80 else 1
                    l2 = b[so]
                    if l2 & 0x80: l2 = ((l2 & 0x7f) << 8) | b[so+1]; so += 2
                    else: so += 1
                    chaines.append(b[so:so+l2].decode('utf-8', 'replace'))
                else:
                    l = u16(so); so += 2
                    if l & 0x8000: l = ((l & 0x7fff) << 16) | u16(so); so += 2
                    chaines.append(b[so:so+2*l].decode('utf-16le', 'replace'))
        elif typ == 0x0102:  # start element
            nom = chaines[u32(o+20)]
            if nom == 'manifest':
                ac, asz = u16(o+28), u16(o+26); ao = o + 16 + u16(o+24)
                for a in range(ac):
                    x = ao + a*asz
                    an = chaines[u32(x+4)]; raw = u32(x+8); dtype = b[x+15]; dval = u32(x+16)
                    res[an] = chaines[raw] if raw != 0xFFFFFFFF else (dval if dtype in (0x10, 0x11) else chaines[dval] if dtype == 0x03 else dval)
                return res
        o += size
    return res

def main():
    apk = sys.argv[1]
    sha = sha256_fichier(apk)
    data = open(apk, 'rb').read()
    blocs = bloc_signature(data)
    schema = 'v2' if 0x7109871a in blocs else 'v3' if 0xf05368c0 in blocs else None
    certs = certificats(blocs[0x7109871a] if schema == 'v2' else blocs[0xf05368c0])
    cert_sha = sorted({hashlib.sha256(c).hexdigest() for c in certs})
    ossl = subprocess.run(['openssl', 'x509', '-inform', 'DER', '-noout', '-fingerprint', '-sha256', '-subject'], input=certs[0], capture_output=True)
    ossl_fp = ossl.stdout.decode().split('=', 1)[1].split('\n')[0].replace(':', '').lower() if ossl.returncode == 0 else None
    subj = [l for l in ossl.stdout.decode().splitlines() if l.startswith('subject')]
    m = axml_manifest(zipfile.ZipFile(apk).read('AndroidManifest.xml'))
    print('fichier', apk); print('taille', len(data)); print('sha256', sha)
    print('schemas_presents', [hex(k) for k in blocs if k in (0x7109871a, 0xf05368c0, 0xf05368c0+1, 0x1b93ad61)])
    print('cert_sha256', cert_sha, '| openssl', ossl_fp, subj)
    print('package', m.get('package'), 'versionCode', m.get('versionCode'), 'versionName', m.get('versionName'))
    ok = True
    if len(sys.argv) > 2 and sys.argv[2] != sha: print('ECART sha256'); ok = False
    if len(sys.argv) > 3 and (cert_sha != [sys.argv[3]] or ossl_fp != sys.argv[3]): print('ECART certificat'); ok = False
    print('VERIF_B_OK' if ok else 'VERIF_B_ECHEC')

if __name__ == '__main__':
    main()
