package com.eventticketing.admin.config;

import com.eventticketing.admin.client.TicketingApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatusCode;
import org.springframework.web.client.RestClient;

@Configuration
public class TicketingClientConfig {

    @Bean
    public RestClient ticketingRestClient(TicketingProperties properties, ObjectMapper objectMapper) {
        return RestClient.builder()
                .baseUrl(properties.baseUrl())
                .defaultStatusHandler(HttpStatusCode::isError, (request, response) -> {
                    int status = response.getStatusCode().value();
                    String message = response.getStatusText();
                    try {
                        JsonNode node = objectMapper.readTree(response.getBody().readAllBytes());
                        if (node.hasNonNull("message")) {
                            message = node.get("message").asText();
                        }
                    } catch (Exception ignored) {
                        // fall back to the status text
                    }
                    throw new TicketingApiException(status, message);
                })
                .build();
    }
}
