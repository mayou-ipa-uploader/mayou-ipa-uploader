import json
import base64
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "p12":
        payload = json.load(sys.stdin)
        certificate_data = base64.b64decode(payload["certificate"])
        try:
            certificate = x509.load_der_x509_certificate(certificate_data)
        except ValueError:
            certificate = x509.load_pem_x509_certificate(certificate_data)
        private_key = serialization.load_pem_private_key(payload["privateKey"].encode("utf-8"), password=None)
        password = str(payload.get("password") or "")
        if not password:
            raise ValueError("P12 密码不能为空")
        output = pkcs12.serialize_key_and_certificates(
            name=str(payload.get("name") or "Apple Certificate").encode("utf-8"),
            key=private_key,
            cert=certificate,
            cas=None,
            encryption_algorithm=serialization.BestAvailableEncryption(password.encode("utf-8")),
        )
        print(json.dumps({"p12": base64.b64encode(output).decode("ascii")}))
        return
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([])).sign(private_key, hashes.SHA256())
    print(json.dumps({
        "csr": csr.public_bytes(serialization.Encoding.PEM).decode("utf-8"),
        "privateKey": private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("utf-8"),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
