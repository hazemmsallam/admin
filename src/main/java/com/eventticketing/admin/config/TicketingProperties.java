package com.eventticketing.admin.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Location of the event-ticketing API this console drives. */
@ConfigurationProperties(prefix = "ticketing")
public record TicketingProperties(String baseUrl) {
}
