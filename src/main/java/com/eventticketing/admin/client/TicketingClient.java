package com.eventticketing.admin.client;

import com.eventticketing.admin.client.dto.CreateEventRequest;
import com.eventticketing.admin.client.dto.CreateHallRequest;
import com.eventticketing.admin.client.dto.CreateLayoutPresetRequest;
import com.eventticketing.admin.client.dto.CreateOrganizerRequest;
import com.eventticketing.admin.client.dto.EventResponse;
import com.eventticketing.admin.client.dto.EventSummaryResponse;
import com.eventticketing.admin.client.dto.HallResponse;
import com.eventticketing.admin.client.dto.HallSummaryResponse;
import com.eventticketing.admin.client.dto.LayoutPresetResponse;
import com.eventticketing.admin.client.dto.LayoutPresetSummaryResponse;
import com.eventticketing.admin.client.dto.OrganizerResponse;
import com.eventticketing.admin.client.dto.SetEventPricingRequest;
import com.eventticketing.admin.client.dto.UpdateEventStatusRequest;
import com.eventticketing.admin.client.dto.UpdateHallRequest;
import com.eventticketing.admin.client.dto.UpdateHallSeatsRequest;
import com.eventticketing.admin.client.dto.UpdateSeatLayoutRequest;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/**
 * Thin wrapper over the event-ticketing REST API. Every method delegates to the shared
 * {@link RestClient}, which translates API errors into {@link TicketingApiException}.
 */
@Component
public class TicketingClient {

    private static final ParameterizedTypeReference<List<OrganizerResponse>> ORGANIZER_LIST =
            new ParameterizedTypeReference<>() {
            };
    private static final ParameterizedTypeReference<List<HallSummaryResponse>> HALL_LIST =
            new ParameterizedTypeReference<>() {
            };
    private static final ParameterizedTypeReference<List<EventSummaryResponse>> EVENT_LIST =
            new ParameterizedTypeReference<>() {
            };
    private static final ParameterizedTypeReference<List<LayoutPresetSummaryResponse>> PRESET_LIST =
            new ParameterizedTypeReference<>() {
            };

    private final RestClient rest;

    public TicketingClient(RestClient ticketingRestClient) {
        this.rest = ticketingRestClient;
    }

    // ---------------------------------------------------------------- organizers

    public List<OrganizerResponse> listOrganizers() {
        return rest.get().uri("/api/organizers").retrieve().body(ORGANIZER_LIST);
    }

    public OrganizerResponse getOrganizer(Long id) {
        return rest.get().uri("/api/organizers/{id}", id).retrieve().body(OrganizerResponse.class);
    }

    public OrganizerResponse createOrganizer(CreateOrganizerRequest request) {
        return rest.post().uri("/api/organizers").body(request).retrieve().body(OrganizerResponse.class);
    }

    public OrganizerResponse updateOrganizer(Long id, CreateOrganizerRequest request) {
        return rest.put().uri("/api/organizers/{id}", id).body(request).retrieve().body(OrganizerResponse.class);
    }

    public void deleteOrganizer(Long id) {
        rest.delete().uri("/api/organizers/{id}", id).retrieve().toBodilessEntity();
    }

    // ---------------------------------------------------------------- halls

    public List<HallSummaryResponse> listHalls() {
        return rest.get().uri("/api/halls").retrieve().body(HALL_LIST);
    }

    public HallResponse getHall(Long id) {
        return rest.get().uri("/api/halls/{id}", id).retrieve().body(HallResponse.class);
    }

    public HallResponse createHall(CreateHallRequest request) {
        return rest.post().uri("/api/halls").body(request).retrieve().body(HallResponse.class);
    }

    public HallResponse updateHall(Long id, UpdateHallRequest request) {
        return rest.put().uri("/api/halls/{id}", id).body(request).retrieve().body(HallResponse.class);
    }

    public HallResponse updateHallLayout(Long id, UpdateSeatLayoutRequest request) {
        return rest.put().uri("/api/halls/{id}/layout", id).body(request).retrieve().body(HallResponse.class);
    }

    public HallResponse updateHallSeats(Long id, UpdateHallSeatsRequest request) {
        return rest.put().uri("/api/halls/{id}/seats", id).body(request).retrieve().body(HallResponse.class);
    }

    public void deleteHall(Long id) {
        rest.delete().uri("/api/halls/{id}", id).retrieve().toBodilessEntity();
    }

    // ---------------------------------------------------------------- events

    public List<EventSummaryResponse> listEvents() {
        return rest.get().uri("/api/events").retrieve().body(EVENT_LIST);
    }

    public EventResponse getEvent(Long id) {
        return rest.get().uri("/api/events/{id}", id).retrieve().body(EventResponse.class);
    }

    public EventResponse createEvent(CreateEventRequest request) {
        return rest.post().uri("/api/events").body(request).retrieve().body(EventResponse.class);
    }

    public EventResponse updateEvent(Long id, CreateEventRequest request) {
        return rest.put().uri("/api/events/{id}", id).body(request).retrieve().body(EventResponse.class);
    }

    public EventResponse setPricing(Long id, SetEventPricingRequest request) {
        return rest.put().uri("/api/events/{id}/pricing", id).body(request).retrieve().body(EventResponse.class);
    }

    public EventResponse updateStatus(Long id, UpdateEventStatusRequest request) {
        return rest.patch().uri("/api/events/{id}/status", id).body(request).retrieve().body(EventResponse.class);
    }

    public void deleteEvent(Long id) {
        rest.delete().uri("/api/events/{id}", id).retrieve().toBodilessEntity();
    }

    // ---------------------------------------------------------------- layout presets

    public List<LayoutPresetSummaryResponse> listLayoutPresets() {
        return rest.get().uri("/api/layout-presets").retrieve().body(PRESET_LIST);
    }

    public LayoutPresetResponse getLayoutPreset(Long id) {
        return rest.get().uri("/api/layout-presets/{id}", id).retrieve().body(LayoutPresetResponse.class);
    }

    public LayoutPresetResponse createLayoutPreset(CreateLayoutPresetRequest request) {
        return rest.post().uri("/api/layout-presets").body(request).retrieve()
                .body(LayoutPresetResponse.class);
    }

    public void deleteLayoutPreset(Long id) {
        rest.delete().uri("/api/layout-presets/{id}", id).retrieve().toBodilessEntity();
    }

    // ---------------------------------------------------------------- uploads

    /**
     * Forwards an image upload to the ticketing API and returns its {@code {"url": "..."}} payload.
     * The admin never touches the file on disk — the backend owns the uploads folder.
     */
    @SuppressWarnings("unchecked")
    public Map<String, String> uploadImage(byte[] bytes, String filename, String contentType) {
        ByteArrayResource resource = new ByteArrayResource(bytes) {
            @Override
            public String getFilename() {
                return filename;
            }
        };
        HttpHeaders partHeaders = new HttpHeaders();
        if (contentType != null && !contentType.isBlank()) {
            // The backend's UploadController validates against image/*; pass what the browser said.
            partHeaders.setContentType(MediaType.parseMediaType(contentType));
        }
        MultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        parts.add("file", new HttpEntity<>(resource, partHeaders));
        return rest.post()
                .uri("/api/uploads/images")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(parts)
                .retrieve()
                .body(Map.class);
    }
}
