"""Локальный CA и HTTPS-сертификат для проверки навигатора с телефона.

Скрипт создаёт в каталоге `certs/`:
  ca.crt / ca.key         — локальный удостоверяющий центр (ставится на телефон один раз);
  server.crt / server.key — сертификат сервера для localhost и адресов компьютера в LAN.

Повторный запуск переиспользует существующий CA и выпускает новый сертификат сервера.
"""

import argparse
import datetime as dt
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parent


def local_addresses():
    """IPv4-адреса компьютера в локальной сети."""
    addresses = set()
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        addresses.add(info[4][0])
    try:
        # Ничего не отправляется: UDP-соединение нужно только для выбора исходящего интерфейса.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.168.1.1", 9))
            addresses.add(probe.getsockname()[0])
    except OSError:
        pass
    return sorted(address for address in addresses if not address.startswith("127."))


def write_key(path, key):
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


def load_or_create_ca(folder, days):
    cert_path = folder / "ca.crt"
    key_path = folder / "ca.key"
    if cert_path.exists() and key_path.exists():
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        return cert, key

    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Navigator Local Dev"),
        x509.NameAttribute(NameOID.COMMON_NAME, "Navigator Local Dev CA"),
    ])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    write_key(key_path, key)
    return cert, key


def build_server_certificate(ca_cert, ca_key, hosts, days):
    dns_names = {"localhost"}
    ip_addresses = {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}
    for host in hosts:
        try:
            ip_addresses.add(ipaddress.ip_address(host))
        except ValueError:
            dns_names.add(host)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    common_name = sorted(dns_names - {"localhost"})[0] if len(dns_names) > 1 else "localhost"
    now = dt.datetime.now(dt.timezone.utc)
    subject = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Navigator Local Dev"),
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])
    alternative_names = [x509.DNSName(name) for name in sorted(dns_names)]
    alternative_names += [x509.IPAddress(address) for address in sorted(ip_addresses, key=str)]
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(alternative_names), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    return cert, key


def main():
    parser = argparse.ArgumentParser(description="Локальный HTTPS-сертификат для телефона")
    parser.add_argument("--output", type=Path, default=ROOT / "certs")
    parser.add_argument(
        "--host",
        action="append",
        default=[],
        help="Дополнительное имя или IP в SAN (можно несколько раз)",
    )
    parser.add_argument("--days", type=int, default=825, help="Срок действия сертификата сервера")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    ca_cert, ca_key = load_or_create_ca(args.output, max(args.days, 3650))
    hosts = set(args.host) | set(local_addresses()) | {socket.gethostname()}
    cert, key = build_server_certificate(ca_cert, ca_key, hosts, args.days)

    (args.output / "server.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    write_key(args.output / "server.key", key)

    print(f"CA_CERT {args.output / 'ca.crt'}")
    print(f"SERVER_CERT {args.output / 'server.crt'}")
    print(f"SERVER_KEY {args.output / 'server.key'}")
    print("HOSTS " + " ".join(sorted(hosts)))


if __name__ == "__main__":
    main()
