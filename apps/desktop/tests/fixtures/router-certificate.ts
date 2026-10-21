/** Public, valid-date local-device certificate for native policy fixtures; contains no private key. */
import { X509Certificate } from 'node:crypto'
// Signed public test leaf; the fixture intentionally has no IP SAN and stores no private key.
const routerPem = `-----BEGIN CERTIFICATE-----
MIIBKjCCAM+gAwIBAgIBATAKBggqhkjOPQQDAjAeMRwwGgYDVQQDDBNyb3V0ZXIu
ZXhhbXBsZS50ZXN0MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEwMTAwMDAwMFowHjEc
MBoGA1UEAwwTcm91dGVyLmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABOWBuGtj0luoknttr0mDMO3rVbrjPKxVVHXdQvMuStYPtyIquPu3TGr2
qL3KJAF4N13Cba44jdaSJ/9c1xGf9qswCgYIKoZIzj0EAwIDSQAwRgIhAM0GK22T
6WMJl84cVYj6KnrIxY1y8CKnnLsm7dNWZ/xTAiEApekUyZaIGvkXYzwUNxVFl7nn
3arjFjLF5XOrMkOPIw0=
-----END CERTIFICATE-----`
const routerLeaf = new X509Certificate(routerPem)
export const routerCertificate: Pick<Electron.Certificate, 'data' | 'fingerprint' | 'validStart' | 'validExpiry'> = {
  data: routerPem, fingerprint: routerLeaf.fingerprint256,
  validStart: routerLeaf.validFromDate.getTime() / 1000, validExpiry: routerLeaf.validToDate.getTime() / 1000,
}
