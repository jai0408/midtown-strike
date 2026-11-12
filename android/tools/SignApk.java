import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Signs an APK with APK Signature Scheme v2 using apksig, then verifies the
 * result the same way the platform would.
 *
 * v1 (JAR) signing is left off on purpose: the app's minSdk is 24, every
 * Android release from 7.0 on verifies v2, and this apksig release's v1
 * signer depends on JDK internals that were removed in newer JDKs.
 *
 * usage: SignApk keystore storepass alias in.apk out.apk minSdk
 */
public final class SignApk {
    public static void main(String[] a) throws Exception {
        if (a.length != 6) {
            System.err.println("usage: SignApk keystore storepass alias in.apk out.apk minSdk");
            System.exit(2);
        }
        char[] pass = a[1].toCharArray();
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        try (FileInputStream in = new FileInputStream(a[0])) {
            ks.load(in, pass);
        }
        PrivateKey key = (PrivateKey) ks.getKey(a[2], pass);
        List<X509Certificate> certs = new ArrayList<>();
        for (Certificate c : ks.getCertificateChain(a[2])) {
            certs.add((X509Certificate) c);
        }
        int minSdk = Integer.parseInt(a[5]);
        File out = new File(a[4]);

        ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder("CERT", key, certs).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(new File(a[3]))
                .setOutputApk(out)
                .setMinSdkVersion(minSdk)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("Midtown Strike build")
                .build()
                .sign();

        if (minSdk < 24) {
            throw new IllegalArgumentException("v2-only signing needs minSdk >= 24");
        }
        ApkVerifier.Result r = new ApkVerifier.Builder(out).setMinCheckedPlatformVersion(minSdk).build().verify();
        for (ApkVerifier.IssueWithParams w : r.getWarnings()) {
            System.out.println("[sign] warning: " + w);
        }
        for (ApkVerifier.IssueWithParams e : r.getErrors()) {
            System.out.println("[sign] ERROR: " + e);
        }
        System.out.println("[sign] verified=" + r.isVerified()
                + " v1=" + r.isVerifiedUsingV1Scheme()
                + " v2=" + r.isVerifiedUsingV2Scheme()
                + " signer=" + certs.get(0).getSubjectX500Principal().getName());
        if (!r.isVerified() || !r.isVerifiedUsingV2Scheme()) {
            System.exit(1);
        }
    }
}
