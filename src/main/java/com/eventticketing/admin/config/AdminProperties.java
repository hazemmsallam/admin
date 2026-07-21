package com.eventticketing.admin.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** The single admin login for the console. */
@ConfigurationProperties(prefix = "admin")
public record AdminProperties(String username, String password) {
}
