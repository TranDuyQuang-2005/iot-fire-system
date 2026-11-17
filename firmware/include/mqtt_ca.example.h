#pragma once

// Download the broker CA certificate from the cloud MQTT deployment console,
// copy this file to mqtt_ca.h, then paste the PEM certificate below.
static const char MQTT_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_BROKER_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF";
